"""Image processing utilities: contrast adjustment, histogram, etc."""

from __future__ import annotations

import io
import numpy as np
from PIL import Image


def adjust_contrast(
    img: np.ndarray, min_val: float, max_val: float
) -> np.ndarray:
    """Apply min/max contrast to uint16 image, return float32 [0, 1]."""
    if max_val <= min_val:
        max_val = min_val + 1
    result = (img.astype(np.float32) - min_val) / (max_val - min_val)
    return np.clip(result, 0.0, 1.0)


def auto_contrast(img: np.ndarray, percentile: float = 0.1) -> tuple[float, float]:
    """Compute auto-contrast min/max based on percentile clipping.

    high is always > low: a uniform or saturated channel otherwise gives a zero
    display range, which renders the channel pure black in the frontend.
    """
    low = float(np.percentile(img, percentile))
    high = float(np.percentile(img, 100 - percentile))
    if high <= low:
        high = low + 1.0
    return low, high


# Full-scale values of the bit depths microscopes actually produce. Snapping to
# these keeps the histogram's x-axis stable while the user steps through slices.
_FULL_SCALES = (255, 1023, 4095, 16383, 65535)


def _data_upper_bound(img: np.ndarray) -> float:
    """Upper end of the histogram range, inferred from the data's real depth."""
    if img.size == 0:
        return float(_FULL_SCALES[-1])
    if np.issubdtype(img.dtype, np.floating):
        return max(1.0, float(np.nanmax(img)))
    dmax = int(img.max())
    for scale in _FULL_SCALES:
        if dmax <= scale:
            return float(scale)
    return float(np.iinfo(img.dtype).max)


def compute_histogram(img: np.ndarray, bins: int = 256,
                      max_value: float | None = None) -> dict:
    """Compute histogram of an image over its actual value range.

    A hardcoded 0..65535 range crams 8- or 12-bit data into the leftmost bins,
    which makes the histogram useless for setting contrast.
    """
    upper = float(max_value) if max_value is not None else _data_upper_bound(img)
    if upper <= 0:
        upper = 1.0
    counts, bin_edges = np.histogram(img, bins=bins, range=(0, upper))
    return {
        "counts": counts.tolist(),
        "bin_edges": bin_edges.tolist(),
    }


def to_png_bytes(img: np.ndarray) -> bytes:
    """Convert a float32 [0,1] or uint16 image to PNG bytes."""
    if img.dtype == np.float32 or img.dtype == np.float64:
        img_u8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    elif img.dtype == np.uint16:
        img_u8 = (img / 256).astype(np.uint8)
    else:
        img_u8 = img.astype(np.uint8)
    pil_img = Image.fromarray(img_u8, mode="L")
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return buf.getvalue()


def to_raw_bytes(img: np.ndarray) -> bytes:
    """Convert uint16 image to raw bytes (little-endian)."""
    return img.astype(np.uint16).tobytes()
