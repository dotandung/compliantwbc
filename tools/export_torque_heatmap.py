"""Bake the per-joint lower-body effort heatmap into figures/torque_heatmap.js.

Mirrors the appendix figure
(``ICRA2027_CompliantWBC/figures/plot_torque_heatmap.py``): the same 12 rows
(six joint groups x left/right), the same 0.1 s display bins, the same
normalisation by the sim effort limits, and the same rule for calling a bin
saturated -- any raw 20 ms sample above 0.9 of the joint's limit.

Usage:
    python tools/export_torque_heatmap.py \\
        --raw-files assets/Twist-Flat.npz assets/Phong-Twist.npz \\
        --labels "TWIST2 (non-compliant)" "Ours (compliant)"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "figures" / "torque_heatmap.js"

# Same sim-side effort table as tools/export_joint_torque_force.py and the
# appendix figure. See that file for why it is inlined rather than imported.
_EFFORT_LIMITS: dict[str, float] = {
  "hip_pitch": 360.0,
  "hip_roll": 360.0,
  "hip_yaw": 130.0,
  "knee_pitch": 360.0,
  "ankle_pitch": 120.0,
  "ankle_roll": 120.0,
}

# Row order: one group at a time, left above right (as in the appendix figure).
_GROUPS = [
  ("hip_pitch", "hip pitch"),
  ("hip_roll", "hip roll"),
  ("hip_yaw", "hip yaw"),
  ("knee_pitch", "knee"),
  ("ankle_pitch", "ankle pitch"),
  ("ankle_roll", "ankle roll"),
]


def _parse_args() -> argparse.Namespace:
  p = argparse.ArgumentParser(description=__doc__)
  p.add_argument(
    "--raw-files", type=Path, nargs="+",
    default=(Path("assets/Twist-Flat.npz"), Path("assets/Phong-Twist.npz")),
    help="One .npz per controller, in display order.",
  )
  p.add_argument(
    "--labels", type=str, nargs="*",
    default=["TWIST2 (non-compliant)", "Ours (compliant)"],
    help="One label per --raw-files.",
  )
  p.add_argument(
    "--sat", type=float, default=0.9,
    help="Saturation threshold as a fraction of the effort limit (default 0.9).",
  )
  p.add_argument(
    "--bin", type=int, default=5,
    help="Raw samples per display bin (5 x 20 ms = 0.1 s, as in the figure).",
  )
  p.add_argument("--output", type=Path, default=OUT, help="Output .js path.")
  return p.parse_args()


def _load(path: Path) -> tuple[np.ndarray, np.ndarray]:
  """Return (t, effort) with effort[T, 12] normalised to the joint limits."""
  if not path.exists():
    raise SystemExit(f"missing: {path}")
  with np.load(path, allow_pickle=True) as z:
    names = [str(s).replace("_joint", "") for s in z["joint_names"]]
    order = [f"{side}_{stem}" for stem, _ in _GROUPS for side in ("left", "right")]
    missing = [o for o in order if o not in names]
    if missing:
      raise SystemExit(f"{path.name} is missing joints: {missing}")
    idx = [names.index(o) for o in order]
    lim = np.array([_EFFORT_LIMITS[o.split("_", 1)[1]] for o in order])
    # [T, 1, J] -> [T, 12]; the capture has a single env per file.
    tau = np.abs(z["tau_lower_force"][:, 0, idx]) / lim
    return np.asarray(z["t"], dtype=float), tau


def main() -> None:
  args = _parse_args()
  labels = list(args.labels) if args.labels else [p.stem for p in args.raw_files]
  if len(labels) != len(args.raw_files):
    raise SystemExit(
      f"--labels has {len(labels)} entries but --raw-files has "
      f"{len(args.raw_files)}; they must match."
    )

  loaded = [_load(p) for p in args.raw_files]
  head = min(len(t) for t, _ in loaded)
  head = (head // args.bin) * args.bin  # whole bins only
  if head == 0:
    raise SystemExit("captures are shorter than one display bin")
  dt = float(loaded[0][0][1] - loaded[0][0][0])
  t_end = round(head * dt, 3)

  runs = []
  for (t, u), label in zip(loaded, labels):
    u = u[:head]
    b = u.reshape(-1, args.bin, u.shape[1])          # [bins, BIN, 12]
    mean_bin = np.clip(b.mean(axis=1), 0.0, 1.0).T   # [12, bins]
    sat_bin = (b.max(axis=1) > args.sat).T           # [12, bins]

    # Cells as integer percent of the limit keeps the payload small; the
    # saturated ones are listed separately so the renderer can flag them
    # instead of relying on a magic value.
    cells = np.rint(mean_bin * 100).astype(int).tolist()
    sat_cells = [[int(r), int(c)] for r, c in zip(*np.nonzero(sat_bin))]

    runs.append({
      "name": label,
      "cells": cells,
      "sat": sat_cells,
      # Row summaries over the raw 20 ms samples, as in the appendix figure.
      "rowMean": [round(float(v), 3) for v in u.mean(axis=0)],
      "rowSatPct": [round(float(v) * 100, 2) for v in (u > args.sat).mean(axis=0)],
      "satPct": round(float((u > args.sat).mean()) * 100, 2),
      "meanEffort": round(float(u.mean()), 3),
    })

  payload = {
    "rows": [
      {"group": pretty, "side": side}
      for _, pretty in _GROUPS for side in ("L", "R")
    ],
    "limits": [
      _EFFORT_LIMITS[stem] for stem, _ in _GROUPS for _ in ("L", "R")
    ],
    "runs": runs,
    "binSec": round(args.bin * dt, 4),
    "tEnd": t_end,
    "satThreshold": args.sat,
  }

  out = args.output
  out.parent.mkdir(parents=True, exist_ok=True)
  # Plain <script src> rather than fetch()ed JSON, so the page also works when
  # opened straight off the filesystem.
  out.write_text(
    "window.__TORQUE_HEATMAP = "
    + json.dumps(payload, separators=(",", ":"))
    + ";\n"
  )
  print(f"[export] wrote {out} ({out.stat().st_size / 1024:.1f} KiB)")
  for r in runs:
    print(f"[export]   {r['name']}: mean {r['meanEffort']:.3f}, "
          f"saturated {r['satPct']:.2f}%")


if __name__ == "__main__":
  main()
