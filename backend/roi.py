"""ROI analysis: intensity profiles, area measurements."""

from __future__ import annotations

import numpy as np
from scipy import ndimage


def line_profile(
    img: np.ndarray,
    x0: int, y0: int,
    x1: int, y1: int,
    width: int = 1,
) -> dict:
    """Extract intensity profile along a line."""
    length = int(np.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2))
    if length == 0:
        return {"distances": [], "intensities": []}
    x_coords = np.linspace(x0, x1, length)
    y_coords = np.linspace(y0, y1, length)

    if width <= 1:
        intensities = ndimage.map_coordinates(
            img.astype(np.float64), [y_coords, x_coords], order=1
        )
    else:
        dx = -(y1 - y0) / length
        dy = (x1 - x0) / length
        intensities = np.zeros(length, dtype=np.float64)
        for offset in np.linspace(-width / 2, width / 2, width):
            xc = x_coords + offset * dx
            yc = y_coords + offset * dy
            intensities += ndimage.map_coordinates(
                img.astype(np.float64), [yc, xc], order=1
            )
        intensities /= width

    pixel_size = 1.0  # will be scaled by caller with metadata
    distances = np.linspace(0, length * pixel_size, length)
    return {
        "distances": distances.tolist(),
        "intensities": intensities.tolist(),
    }


def measure_roi(
    img: np.ndarray,
    roi_type: str,
    params: dict,
    pixel_size_x: float = 1.0,
    pixel_size_y: float = 1.0,
) -> dict:
    """Measure statistics within an ROI.

    roi_type: "rect" | "ellipse" | "polygon"
    params:
      rect: {x, y, width, height}
      ellipse: {cx, cy, rx, ry}
      polygon: {points: [[x,y], ...]}
    """
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    mask = np.zeros((h, w), dtype=bool)

    if roi_type == "rect":
        x, y = int(params["x"]), int(params["y"])
        rw, rh = int(params["width"]), int(params["height"])
        # Clamp to the array: negative slice bounds (a rect straddling the top or
        # left edge) select nothing and the ROI measures zero pixels.
        x0, x1 = sorted((x, x + rw))
        y0, y1 = sorted((y, y + rh))
        x0, x1 = max(0, x0), min(w, x1)
        y0, y1 = max(0, y0), min(h, y1)
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = True
    elif roi_type == "ellipse":
        cx, cy = params["cx"], params["cy"]
        rx, ry = params["rx"], params["ry"]
        if rx > 0 and ry > 0:
            mask = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    elif roi_type == "polygon":
        from matplotlib.path import Path

        points = params["points"]
        if len(points) >= 3:
            path = Path(points)
            coords = np.column_stack([xx.ravel(), yy.ravel()])
            mask = path.contains_points(coords).reshape(h, w)

    if not np.any(mask):
        return {"area_pixels": 0, "area_um2": 0, "mean": 0, "std": 0, "min": 0, "max": 0}

    values = img[mask].astype(np.float64)
    area_pixels = int(np.sum(mask))
    area_um2 = area_pixels * pixel_size_x * pixel_size_y

    return {
        "area_pixels": area_pixels,
        "area_um2": round(area_um2, 4),
        "mean": round(float(np.mean(values)), 2),
        "std": round(float(np.std(values)), 2),
        "min": int(np.min(values)),
        "max": int(np.max(values)),
    }
