"""The neural architectures. Same input, same output shape, same training loop.

lstm, gru, cnn_lstm: recurrent networks over the 48-hour window.
transformer: a spatio-temporal Transformer. Each of the five points (the city
and its four neighbours ~55 km away) gets its window cut into patches of a few
hours; every patch of every point becomes a token, and self-attention runs over
all of them at once, so the model can relate, say, the west point's pressure
18 hours ago to the city's next day. With five points this is attention over a
fully connected spatial graph, learned jointly with time.
"""

from __future__ import annotations

import keras
from keras import layers, ops

from .config import POINT_FEATURES, POINTS

RNN_NAMES = ("lstm", "gru", "cnn_lstm")
TRANSFORMER_NAME = "transformer"
MODEL_NAMES = RNN_NAMES + (TRANSFORMER_NAME,)
ENSEMBLE_NAME = "ensemble"
DISPLAY_NAMES = {
    "lstm": "LSTM",
    "gru": "GRU",
    "cnn_lstm": "CNN-LSTM",
    "transformer": "ST-Transformer",
    "lightgbm": "LightGBM",
    "ensemble": "Ensemble",
}

TRANSFORMER_DEFAULTS = {"patch": 6, "dim": 64, "layers": 2, "heads": 4, "dropout": 0.1}


@keras.saving.register_keras_serializable(package="weatherai")
class SpatialPatchTokens(layers.Layer):
    """Cuts the input window into tokens: one per patch of hours at each point.

    Input is (batch, lookback, features). Output is (batch, tokens, token size), with
    points times patches tokens, each holding a patch of the point's own features
    plus the shared features for the same hours. The feature order is point-major (see config.FEATURE_ORDER): each point's
    features come first, then the shared time and location features, which are
    attached to every point's tokens. Tokens are ordered point by point, so the
    city's tokens (point 0) are the first `patches`."""

    def __init__(self, n_points: int, n_point_features: int, patch: int, name=None, trainable=True, dtype=None):
        # Keras hands name, trainable and dtype back in when it loads a saved model.
        super().__init__(name=name, trainable=trainable, dtype=dtype)
        self.n_points, self.n_point_features, self.patch = n_points, n_point_features, patch

    def build(self, input_shape):
        self.lookback, self.n_features = int(input_shape[1]), int(input_shape[2])
        if self.lookback % self.patch:
            raise ValueError(f"lookback {self.lookback} is not a multiple of patch {self.patch}")
        self.n_patches = self.lookback // self.patch
        self.n_shared = self.n_features - self.n_points * self.n_point_features

    def call(self, x):
        P, Fp, p, N, S = self.n_points, self.n_point_features, self.patch, self.n_patches, self.n_shared
        points = ops.reshape(x[:, :, : P * Fp], (-1, N, p, P, Fp))
        points = ops.reshape(ops.transpose(points, (0, 3, 1, 2, 4)), (-1, P, N, p * Fp))
        shared = ops.reshape(x[:, :, P * Fp :], (-1, 1, N, p * S))
        shared = ops.repeat(shared, P, axis=1)
        tokens = ops.concatenate([points, shared], axis=-1)
        return ops.reshape(tokens, (-1, P * N, p * (Fp + S)))

    def compute_output_shape(self, input_shape):
        lookback, features = int(input_shape[1]), int(input_shape[2])
        return (input_shape[0], self.n_points * (lookback // self.patch), self.patch * (features - self.n_points * self.n_point_features + self.n_point_features))

    def get_config(self):
        return super().get_config() | {"n_points": self.n_points, "n_point_features": self.n_point_features, "patch": self.patch}


@keras.saving.register_keras_serializable(package="weatherai")
class TokenPositions(layers.Layer):
    """Adds a learned embedding per token position (which point, which patch)."""

    def build(self, input_shape):
        self.positions = self.add_weight(
            name="positions", shape=(int(input_shape[1]), int(input_shape[2])), initializer=keras.initializers.RandomNormal(stddev=0.02)
        )

    def call(self, x):
        return x + self.positions


@keras.saving.register_keras_serializable(package="weatherai")
class PointTokens(layers.Layer):
    """The tokens of one point (default the city, point 0)."""

    def __init__(self, n_points: int, point: int = 0, name=None, trainable=True, dtype=None):
        super().__init__(name=name, trainable=trainable, dtype=dtype)
        self.n_points, self.point = n_points, point

    def call(self, x):
        n = ops.shape(x)[1] // self.n_points
        return x[:, self.point * n : (self.point + 1) * n, :]

    def compute_output_shape(self, input_shape):
        return (input_shape[0], int(input_shape[1]) // self.n_points, input_shape[2])

    def get_config(self):
        return super().get_config() | {"n_points": self.n_points, "point": self.point}


def _encoder_block(x, dim: int, heads: int, dropout: float):
    """One pre-norm Transformer encoder layer: self-attention, then a small feed-forward network."""
    h = layers.LayerNormalization(epsilon=1e-6)(x)
    h = layers.MultiHeadAttention(num_heads=heads, key_dim=dim // heads, dropout=dropout)(h, h)
    x = layers.Add()([x, layers.Dropout(dropout)(h)])
    h = layers.LayerNormalization(epsilon=1e-6)(x)
    h = layers.Dense(dim * 2, activation="gelu")(h)
    h = layers.Dense(dim)(layers.Dropout(dropout)(h))
    return layers.Add()([x, layers.Dropout(dropout)(h)])


def build_model(
    name: str,
    lookback: int,
    n_features: int,
    horizon: int,
    n_targets: int,
    loss: str = "mse",
    options: dict | None = None,
) -> keras.Model:
    """A compiled network by name. Every architecture maps the same input window to (horizon, n_targets)."""
    inputs = keras.Input(shape=(lookback, n_features), name="history")
    if name == "lstm":
        x = layers.LSTM(64, return_sequences=True)(inputs)
        x = layers.Dropout(0.2)(x)
        x = layers.LSTM(64)(x)
    elif name == "gru":
        x = layers.GRU(64, return_sequences=True)(inputs)
        x = layers.Dropout(0.2)(x)
        x = layers.GRU(64)(x)
    elif name == "cnn_lstm":
        # Causal convolutions pick up short-range patterns across the spatial
        # channels; the LSTM then models how they evolve over time.
        x = layers.Conv1D(64, 3, padding="causal", activation="relu")(inputs)
        x = layers.Conv1D(64, 3, padding="causal", activation="relu")(x)
        x = layers.MaxPooling1D(2)(x)
        x = layers.Dropout(0.2)(x)
        x = layers.LSTM(64)(x)
    elif name == TRANSFORMER_NAME:
        o = TRANSFORMER_DEFAULTS | (options or {})
        tokens = SpatialPatchTokens(len(POINTS), len(POINT_FEATURES), o["patch"], name="patch_tokens")(inputs)
        x = TokenPositions(name="positions")(layers.Dense(o["dim"], name="token_embedding")(tokens))
        for _ in range(o["layers"]):
            x = _encoder_block(x, o["dim"], o["heads"], o["dropout"])
        x = layers.LayerNormalization(epsilon=1e-6)(x)
        x = layers.Flatten()(PointTokens(len(POINTS), 0, name="city_tokens")(x))
        x = layers.Dropout(o["dropout"])(x)
    else:
        raise ValueError(f"unknown model {name!r}")
    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dense(horizon * n_targets)(x)
    outputs = layers.Reshape((horizon, n_targets), name="forecast")(x)
    model = keras.Model(inputs, outputs, name=name)
    loss_fn = keras.losses.Huber(delta=1.0) if loss == "huber" else "mse"
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss=loss_fn, metrics=["mae"])
    return model
