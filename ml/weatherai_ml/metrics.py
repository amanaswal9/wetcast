"""Metric helpers (plain NumPy so they're easy to test)."""

from __future__ import annotations

import math

import numpy as np


def mae(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean(np.abs(y - p)))


def rmse(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y - p) ** 2)))


def r2(y: np.ndarray, p: np.ndarray) -> float:
    ss_res = float(np.sum((y - p) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    return 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")


def summary(y: np.ndarray, p: np.ndarray) -> dict[str, float]:
    y = np.asarray(y, dtype=float).ravel()
    p = np.asarray(p, dtype=float).ravel()
    keep = np.isfinite(y) & np.isfinite(p)
    y, p = y[keep], p[keep]
    return {"mae": mae(y, p), "rmse": rmse(y, p), "r2": r2(y, p), "n": int(y.size)}


def conformal_halfwidth(abs_residuals: np.ndarray, level: float) -> float:
    """Split-conformal quantile: with n calibration residuals, the
    ceil((n+1)*level)/n empirical quantile gives >= `level` coverage on
    exchangeable data."""
    r = np.sort(np.asarray(abs_residuals, dtype=float).ravel())
    n = r.size
    if n == 0:
        return float("nan")
    k = min(n, math.ceil((n + 1) * level))
    return float(r[k - 1])
