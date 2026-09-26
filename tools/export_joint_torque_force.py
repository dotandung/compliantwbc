"""Bake the two-joint torque/log|F| comparison into figures/joint_torque_force.js.

Mirrors the offline renderer
(``vr_twist2_mjlab/tools/plot_joint_torque_with_force.py``) invoked as::

    python tools/plot_joint_torque_with_force.py \\
        --raw-files eval_out/force100/compare/Twist-Flat.npz \\
                    eval_out/force100/compare/Phong-Twist.npz \\
        --labels non-compliant compliant \\
        --joints right_ankle_pitch left_hip_yaw \\
        --tau-ymax 150 \\
        --output eval_out/force100/compare/two_joints_logF.png

so the interactive plot on the project page shows the same traces, palette,
soft-bound lines and joint ordering as the published figure (figures/torque.jpeg).

Usage:
    python tools/export_joint_torque_force.py \\
        --raw-files assets/Twist-Flat.npz assets/Phong-Twist.npz \\
        --labels non-compliant compliant \\
        --joints right_ankle_pitch left_hip_yaw \\
        --tau-ymax 150
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "figures" / "joint_torque_force.js"

# Trace colours are deliberately NOT baked in here. The page picks them at
# draw time from RUN_COLORS at the top of torqueplot.js, so recolouring the
# plot needs no re-export. This file only fixes the *order* of the runs that
# RUN_COLORS indexes into.

# VR_M3_EFFORT_LIMITS as used by the eval that produced figures/torque.jpeg
# (src/twist2_mjlab/assets/VR_M3/vr_m3_12dof_constants.py in vr_twist2_mjlab:
# ankle_pitch = MAX_TAU_P60N30 * 2 = 120, hip_yaw = MAX_TAU_P90N20 = 130).
# Inlined rather than imported because this repo is the standalone project
# page — it has no dependency on the training repo. Note the *deploy* table
# (deploy/real/vr_m3_constants.py) lists a different ankle_pitch limit; the
# sim-side table above is the one the published figure's bounds came from.
_EFFORT_LIMITS: dict[str, float] = {
  "hip_pitch": 360.0,
  "hip_roll": 360.0,
  "hip_yaw": 130.0,
  "knee_pitch": 360.0,
  "ankle_pitch": 120.0,
  "ankle_roll": 120.0,
}


def _parse_args() -> argparse.Namespace:
  p = argparse.ArgumentParser(description=__doc__)
  p.add_argument(
    "--raw-files", type=Path, nargs="+",
    default=(Path("assets/Twist-Flat.npz"), Path("assets/Phong-Twist.npz")),
    help="Two or more .npz files from plot_lower_body_torques.py --raw-output.",
  )
  p.add_argument(
    "--labels", type=str, nargs="*", default=["non-compliant", "compliant"],
    help="One label per --raw-files. Defaults to the paper's two conditions.",
  )
  p.add_argument(
    "--joints", type=str, nargs="+",
    default=("right_ankle_pitch", "left_hip_yaw"),
    help=(
      "Joint names to plot, one panel each. Partial substring matching: "
      "'right_ankle_pitch' matches 'right_ankle_pitch_joint'."
    ),
  )
  p.add_argument(
    "--force-floor", type=float, default=1.0,
    help=(
      "Floor added to |F| before taking log10 to avoid -inf during the quiet "
      "window (default 1.0 N -> log10 hits 0 when no force is applied)."
    ),
  )
  p.add_argument(
    "--bound-fraction", type=float, default=0.9,
    help="Soft bound drawn at ±fraction × effort limit (default 0.9).",
  )
  p.add_argument(
    "--tau-ymax", type=float, default=150.0,
    help="τ axis spans ±YMAX (N·m) on every panel, as in the published figure.",
  )
  p.add_argument("--output", type=Path, default=OUT, help="Output .js path.")
  return p.parse_args()


def _load(path: Path) -> dict:
  if not path.exists():
    raise SystemExit(f"missing: {path}")
  with np.load(path, allow_pickle=True) as z:
    return {
      "t": z["t"],
      "joint_names": [str(n) for n in z["joint_names"]],
      "tau": z["tau_lower_force"],  # [T, N, J]
      "force_mag": z["force_mag"],  # [T, N]
      "peak_force_n": (
        float(z["peak_force_n"]) if "peak_force_n" in z.files else float("nan")
      ),
    }


def _match_joint(query: str, names: list[str]) -> str:
  exact = [n for n in names if n == query]
  if exact:
    return exact[0]
  hits = [n for n in names if query in n]
  if len(hits) == 1:
    return hits[0]
  if not hits:
    raise SystemExit(f"joint '{query}' not found. Available: {names}")
  raise SystemExit(f"joint '{query}' is ambiguous; matches: {hits}.")


def _effort_limit_for_joint(joint_name: str) -> float | None:
  """Map e.g. 'left_hip_yaw_joint' -> _EFFORT_LIMITS['hip_yaw']."""
  stem = joint_name
  for prefix in ("left_", "right_"):
    if stem.startswith(prefix):
      stem = stem[len(prefix):]
      break
  if stem.endswith("_joint"):
    stem = stem[: -len("_joint")]
  return _EFFORT_LIMITS.get(stem)


def main() -> None:
  args = _parse_args()
  labels = list(args.labels) if args.labels else [p.stem for p in args.raw_files]
  if len(labels) != len(args.raw_files):
    raise SystemExit(
      f"--labels has {len(labels)} entries but --raw-files has "
      f"{len(args.raw_files)}; they must match."
    )

  runs = [_load(p) for p in args.raw_files]

  # The runs share a deterministic force schedule and time base by
  # construction; if a capture ran short, truncate everything to the shortest
  # so the time alignment stays honest (same rule as the offline renderer).
  head = min(len(r["t"]) for r in runs)
  lens = {len(r["t"]) for r in runs}
  if len(lens) > 1:
    print(f"[export]  WARN: capture lengths differ {sorted(lens)}; using {head}.")
  t = runs[0]["t"][:head]

  resolved = [_match_joint(q, runs[0]["joint_names"]) for q in args.joints]
  print(f"[export] joints resolved: {list(zip(args.joints, resolved))}")

  # One shared log10(|F|) trace, averaged across runs (they should agree).
  stacked = np.stack(
    [r["force_mag"][:head].mean(axis=1) for r in runs], axis=0
  )
  max_diff = float(np.max(np.abs(stacked - stacked[0:1])))
  if max_diff > 1.0:
    print(
      f"[export]  WARN: |F| traces differ across runs (max abs diff "
      f"{max_diff:.2f} N) — the force schedule was not identical."
    )
  fmag = stacked.mean(axis=0)
  log_f = np.log10(np.maximum(fmag, args.force_floor))

  panels = []
  for joint_name in resolved:
    tau_series = []
    for run, label in zip(runs, labels):
      if joint_name not in run["joint_names"]:
        print(f"[export]  WARN: {label} has no joint '{joint_name}', zero-filled.")
        tau_series.append(np.zeros(head))
        continue
      jdx = run["joint_names"].index(joint_name)
      tau_series.append(run["tau"][:head, :, jdx].mean(axis=1))

    limit = _effort_limit_for_joint(joint_name)
    if limit is None:
      print(f"[export]  WARN: no effort limit for '{joint_name}'; no bound drawn.")
    panels.append({
      "joint": joint_name,
      "bound": None if limit is None else round(args.bound_fraction * limit, 2),
      # 1 decimal is ~0.3 px at the rendered axis scale — well below line width.
      "tau": [[round(float(v), 1) for v in s] for s in tau_series],
    })

  peaks = sorted(
    {round(r["peak_force_n"]) for r in runs if not np.isnan(r["peak_force_n"])}
  )
  payload = {
    "runs": [{"name": lab} for lab in labels],
    "t": [round(float(v), 3) for v in t],
    "logF": [round(float(v), 3) for v in log_f],
    "forceN": [round(float(v), 1) for v in fmag],
    "panels": panels,
    "tauMax": args.tau_ymax,
    "peakForceN": peaks[0] if len(peaks) == 1 else peaks,
  }

  out = args.output
  out.parent.mkdir(parents=True, exist_ok=True)
  # Plain <script src> rather than fetch()ed JSON, so the page also works when
  # opened straight off the filesystem.
  out.write_text(
    "window.__JOINT_TORQUE_FORCE = "
    + json.dumps(payload, separators=(",", ":"))
    + ";\n"
  )
  print(f"[export] wrote {out} ({out.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
  main()
