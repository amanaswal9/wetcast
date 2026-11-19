"""The three architectures. Same input, same output shape, same training loop."""

from __future__ import annotations

import keras
from keras import layers

MODEL_NAMES = ("lstm", "gru", "cnn_lstm")
ENSEMBLE_NAME = "ensemble"
DISPLAY_NAMES = {"lstm": "LSTM", "gru": "GRU", "cnn_lstm": "CNN-LSTM", "lightgbm": "LightGBM", "ensemble": "Ensemble"}


def build_model(name: str, lookback: int, n_features: int, horizon: int, n_targets: int, loss: str = "mse") -> keras.Model:
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
    else:
        raise ValueError(f"unknown model {name!r}")
    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dense(horizon * n_targets)(x)
    outputs = layers.Reshape((horizon, n_targets), name="forecast")(x)
    model = keras.Model(inputs, outputs, name=name)
    loss_fn = keras.losses.Huber(delta=1.0) if loss == "huber" else "mse"
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss=loss_fn, metrics=["mae"])
    return model
