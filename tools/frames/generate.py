#!/usr/bin/env python3
"""Deterministic frame repair pipeline for the desktop pet frame pack.

The original 30-frame pack was produced by an out-of-tree script that was never
committed, so the only way to repair a bad action was to regenerate everything
from scratch.  This module keeps the *approved* art as the source of truth and
re-derives individual actions with an explicit, inspectable deformation model.

Design rules (all actions):
  * 512x512 RGBA, transparent background, bilinear resampling in premultiplied
    alpha so edges never pick up a dark or white fringe.
  * The head (y < HEAD_LOCK_Y) is rigid: it may be translated, never scaled.
  * Every output frame keeps a minimum transparent margin at the canvas edge,
    so a pose can never be sliced flat by the frame boundary.
  * Feet stay on GROUND_Y so the sprite does not bob between frames.

Usage:
  python3 tools/frames/generate.py --action happy --action sit
  python3 tools/frames/generate.py --check          # verify shipped frames
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CANVAS = 512
GROUND_Y = 474.0
HEAD_LOCK_Y = 240.0
MIN_TOP_MARGIN = 16
MIN_BOTTOM_MARGIN = 8

REPO_ROOT = Path(__file__).resolve().parents[2]
FRAME_ROOT = REPO_ROOT / "frame-pack"
PUBLIC_ROOT = REPO_ROOT / "public" / "frame-pack"


# --------------------------------------------------------------------------- io


def load_rgba(path: Path) -> np.ndarray:
    """Return float32 premultiplied RGBA in [0, 1]."""
    image = Image.open(path).convert("RGBA")
    data = np.asarray(image, dtype=np.float32) / 255.0
    data[..., :3] *= data[..., 3:4]
    return data


def save_rgba(premultiplied: np.ndarray, path: Path) -> None:
    alpha = premultiplied[..., 3:4]
    rgb = np.divide(premultiplied[..., :3], np.maximum(alpha, 1e-6))
    rgba = np.concatenate([rgb, alpha], axis=-1)
    data = np.clip(rgba * 255.0 + 0.5, 0, 255).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(data, mode="RGBA").save(path, optimize=True)


# ------------------------------------------------------------------- resampling


def warp(source: np.ndarray, sample_x: np.ndarray, sample_y: np.ndarray) -> np.ndarray:
    """Bilinear inverse warp: output[y, x] = source[sample_y[y, x], sample_x[y, x]]."""
    height, width = source.shape[:2]
    x0 = np.floor(sample_x)
    y0 = np.floor(sample_y)
    fx = (sample_x - x0)[..., None]
    fy = (sample_y - y0)[..., None]
    x0i = np.clip(x0, 0, width - 1).astype(np.int32)
    y0i = np.clip(y0, 0, height - 1).astype(np.int32)
    x1i = np.clip(x0 + 1, 0, width - 1).astype(np.int32)
    y1i = np.clip(y0 + 1, 0, height - 1).astype(np.int32)

    top = source[y0i, x0i] * (1 - fx) + source[y0i, x1i] * fx
    bottom = source[y1i, x0i] * (1 - fx) + source[y1i, x1i] * fx
    result = top * (1 - fy) + bottom * fy

    inside = (
        (sample_x >= -0.5)
        & (sample_x <= width - 0.5)
        & (sample_y >= -0.5)
        & (sample_y <= height - 0.5)
    )
    result[~inside] = 0.0
    return result


def grid() -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.mgrid[0:CANVAS, 0:CANVAS].astype(np.float32)
    return xs, ys


def scale_about(source: np.ndarray, factor: float, anchor_x: float, anchor_y: float,
                offset_y: float = 0.0) -> np.ndarray:
    """Uniform scale around (anchor_x, anchor_y), then translate by offset_y."""
    xs, ys = grid()
    sample_x = (xs - anchor_x) / factor + anchor_x
    sample_y = (ys - offset_y - anchor_y) / factor + anchor_y
    return warp(source, sample_x, sample_y)


# -------------------------------------------------------------------- geometry


def subject_bounds(frame: np.ndarray) -> tuple[int, int, int, int]:
    mask = frame[..., 3] > 8.0 / 255.0
    ys, xs = np.where(mask)
    if len(ys) == 0:
        raise ValueError("frame is fully transparent")
    return int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    t = np.clip((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ----------------------------------------------------------------------- happy


# (target subject height, feet baseline)
HAPPY_PLAN = [
    (402.0, GROUND_Y),          # rest
    (406.0, GROUND_Y - 10.0),   # lift
    (410.0, GROUND_Y - 20.0),   # apex
    (404.0, GROUND_Y - 8.0),    # settle
    (402.0, GROUND_Y),          # back to rest
]


def build_happy() -> dict[str, np.ndarray]:
    """Rebuild the bounce with a bounded vertical travel.

    The shipped 001/002 frames were a 1.12x vertical stretch anchored at the feet
    and lifted ~39px, which pushed the crown to y=-12 and sliced it flat.  Every
    frame is now a uniform scale about the feet plus a bounded lift, so the crown
    keeps at least MIN_TOP_MARGIN rows of transparency at the apex.

    The squint frames were the only closed-eye art in the pack and they are the
    clipped ones; their faces come from a different render (oversized arcs, flat
    shading) and do not composite cleanly, so the bounce keeps the open-eye base.
    """
    base = load_rgba(FRAME_ROOT / "happy" / "000.png")
    top, bottom, _, _ = subject_bounds(base)

    frames: dict[str, np.ndarray] = {}
    for index, (target_height, feet_y) in enumerate(HAPPY_PLAN):
        factor = target_height / (bottom - top + 1)
        offset_y = feet_y - bottom
        frames[f"{index:03d}"] = scale_about(base, factor, CANVAS / 2, bottom, offset_y)
    return frames


# ------------------------------------------------------------------------- sit


SIT_HEAD_DROP = 64.0     # how far the rigid head settles down
SIT_BELLY_BIAS = 2.2     # >1 pushes the compression towards the ground
SIT_HIP_BULGE = 0.15     # lateral widening at the bottom (squash keeps volume)
SIT_KNEE_AMP = 18.0      # outward push at knee height so the legs read as bent
SIT_KNEE_Y = 430.0
SIT_KNEE_SIGMA = 50.0


def sit_field(xs: np.ndarray, ys: np.ndarray, amount: float = 1.0):
    """Inverse map: seated output pixel -> standing source pixel.

    Above HEAD_LOCK_Y the head is translated rigidly by SIT_HEAD_DROP.  Below it
    the shift decays to zero at the ground, so the feet stay planted while the
    torso absorbs the drop.  A bias > 1 spends most of that budget just above the
    floor, which flattens the belly against the ground instead of compressing the
    chest and arms.

    Two shaping terms keep the legs readable instead of letting the belly swallow
    them: a lateral widening near the floor, and an outward push centred on the
    knees, which bends the leg outline outwards while the feet stay planted.
    """
    span = GROUND_Y - HEAD_LOCK_Y
    t = np.clip((ys - HEAD_LOCK_Y) / span, 0.0, 1.0)
    settle = np.where(ys <= HEAD_LOCK_Y, 1.0, 1.0 - t ** SIT_BELLY_BIAS)
    sample_y = ys - SIT_HEAD_DROP * amount * settle

    widen = 1.0 + SIT_HIP_BULGE * amount * smoothstep(0.65, 1.0, t)
    sample_x = CANVAS / 2 + (xs - CANVAS / 2) / widen

    outer = smoothstep(55.0, 95.0, np.abs(xs - CANVAS / 2))
    knee = np.exp(-((ys - SIT_KNEE_Y) ** 2) / (2.0 * SIT_KNEE_SIGMA ** 2)) * outer
    sample_x = sample_x - np.sign(xs - CANVAS / 2) * SIT_KNEE_AMP * amount * knee
    return sample_x, sample_y


def build_sit() -> dict[str, np.ndarray]:
    """Rebuild the seated pose from the standing idle art.

    The previous sit compressed the whole lower body uniformly, which flattened
    the crotch and left the feet hanging off a straight belly edge.  The new
    field keeps the head rigid, flattens the belly against the ground and keeps
    the thighs readable.

    The old closed-eye "sleepy sit" frame was deliberately dropped: it is a
    different render (flat yellow eyelids, oversized lash arcs) and reads as a
    pasted-on sticker next to the open-eye frames.
    """
    base = load_rgba(FRAME_ROOT / "idle" / "000.png")
    xs, ys = grid()

    # Ease into the seat, overshoot slightly, then settle.
    plan = (0.55, 0.85, 1.0, 0.97, 1.0)
    frames = {
        f"{index:03d}": warp(base, *sit_field(xs, ys, amount))
        for index, amount in enumerate(plan)
    }
    return frames


# ---------------------------------------------------------------------- checks


def check_frame(path: Path) -> list[str]:
    frame = load_rgba(path)
    top, bottom, _, _ = subject_bounds(frame)
    problems = []
    if top < MIN_TOP_MARGIN:
        problems.append(f"{path.name}: crown at y={top} (need >= {MIN_TOP_MARGIN})")
    if bottom > CANVAS - MIN_BOTTOM_MARGIN:
        problems.append(f"{path.name}: feet at y={bottom} (need <= {CANVAS - MIN_BOTTOM_MARGIN})")
    return problems


def check_pack(root: Path) -> list[str]:
    problems: list[str] = []
    for action in ("idle", "walk", "sit", "sleep", "happy", "jump"):
        action_dir = root / action
        frames = sorted(action_dir.glob("*.png"))
        if len(frames) < 5:
            problems.append(f"{action}: only {len(frames)} frames")
            continue
        for frame in frames:
            problems.extend(check_frame(frame))
    return problems


# ------------------------------------------------------------------------ main


BUILDERS = {"happy": build_happy, "sit": build_sit}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", action="append", choices=sorted(BUILDERS))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--out", type=Path, default=FRAME_ROOT)
    parser.add_argument("--sync-public", action="store_true")
    args = parser.parse_args(argv)

    if args.check:
        problems = check_pack(FRAME_ROOT)
        for problem in problems:
            print(f"FAIL {problem}")
        print("frame pack OK" if not problems else f"{len(problems)} problem(s)")
        return 1 if problems else 0

    if not args.action and not args.sync_public:
        parser.error("nothing to do: pass --action, --sync-public or --check")

    for action in args.action or []:
        frames = BUILDERS[action]()
        for name, frame in frames.items():
            target = args.out / action / f"{name}.png"
            save_rgba(frame, target)
            top, bottom, _, _ = subject_bounds(frame)
            label = target.relative_to(REPO_ROOT) if target.is_relative_to(REPO_ROOT) else target
            print(f"wrote {label}  crown={top:3d} feet={bottom:3d}")

    if args.sync_public:
        import shutil

        shutil.rmtree(PUBLIC_ROOT, ignore_errors=True)
        shutil.copytree(args.out, PUBLIC_ROOT)
        label = args.out.relative_to(REPO_ROOT) if args.out.is_relative_to(REPO_ROOT) else args.out
        print(f"synced {label} -> {PUBLIC_ROOT.relative_to(REPO_ROOT)}")

    problems = check_pack(args.out)
    for problem in problems:
        print(f"FAIL {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
