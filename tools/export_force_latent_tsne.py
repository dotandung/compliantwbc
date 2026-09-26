"""Bake the 3-D force-latent t-SNE into figures/force_latent_tsne_3d.js.

Mirrors the grouped / per-class-300 / 3-D configuration of the offline renderer
(``vr_twist2_mjlab/tools/plot_force_latent_tsne.py --3d --group-labels``) so the
interactive plot on the project page shows exactly the same embedding, palette
and class ordering as the published figure.

Usage:
    uv run --with scikit-learn python tools/export_force_latent_tsne.py [NPZ]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.manifold import TSNE

NPZ = Path(
  sys.argv[1] if len(sys.argv) > 1 else
  "../vr_twist2_mjlab/logs/force_latent_tsne/"
  "2026-05-22_19-01-00_vr_m3_mild_force_latent_v2_model_35000/force_latent_tsne.npz"
)
OUT = Path(__file__).resolve().parent.parent / "figures" / "force_latent_tsne_3d.js"

_GROUP_MAP = (0, 1, 2, 4, 3, 4, 4, 4)
_GROUP_NAMES = ("None", "Left", "Right", "Center", "Mix")
_PASTEL_PALETTE = ("#0f3ea5", "#ffb703", "#0F939C", "#8F0111", "#006400")
PER_CLASS = 300


def _select_representative(latents, labels, per_class):
  chosen = []
  for cls in sorted(set(labels.tolist())):
    cls_idx = np.flatnonzero(labels == cls)
    if cls_idx.size == 0:
      continue
    cls_lat = latents[cls_idx]
    centroid = cls_lat.mean(axis=0, keepdims=True)
    dist = np.linalg.norm(cls_lat - centroid, axis=1)
    k = min(per_class, cls_idx.size)
    chosen.append(cls_idx[np.argsort(dist)[:k]])
  return np.concatenate(chosen) if chosen else np.array([], dtype=int)


def main() -> None:
  data = np.load(NPZ)
  latents = data["latents"]
  labels = data["labels"].astype(int)
  force_norm = data["force_norm"]

  plot_labels = np.array(_GROUP_MAP, dtype=labels.dtype)[labels]
  keep = _select_representative(latents, plot_labels, PER_CLASS)
  latents = latents[keep]
  plot_labels = plot_labels[keep]
  force_norm = force_norm[keep]
  print(f"[export] {len(keep)} points; per-class counts {np.bincount(plot_labels)}")

  perplexity = max(5.0, min(30.0, (latents.shape[0] - 1) / 3.0))
  emb = TSNE(
    n_components=3, init="pca", perplexity=perplexity, random_state=0
  ).fit_transform(latents)

  # Map each axis onto [-1, 1] independently — mplot3d autoscales per axis and
  # then draws a cube, so this reproduces the figure's framing.
  lo, hi = emb.min(axis=0, keepdims=True), emb.max(axis=0, keepdims=True)
  emb = 2.0 * (emb - lo) / np.maximum(hi - lo, 1e-9) - 1.0

  cls_list = sorted(set(plot_labels.tolist()))
  payload = {
    "classes": [
      {
        "id": int(c),
        "name": _GROUP_NAMES[c],
        "color": _PASTEL_PALETTE[i % len(_PASTEL_PALETTE)],
      }
      for i, c in enumerate(cls_list)
    ],
    # Flat arrays keep the JSON small; 3 decimals is well below marker size.
    "xyz": [round(float(v), 3) for v in emb.ravel()],
    "label": [int(v) for v in plot_labels],
    "force": [round(float(v), 1) for v in force_norm],
  }
  OUT.parent.mkdir(parents=True, exist_ok=True)
  # Plain <script src> rather than fetch()ed JSON, so the page also works when
  # opened straight off the filesystem.
  OUT.write_text(
    "window.__FORCE_LATENT_TSNE = "
    + json.dumps(payload, separators=(",", ":"))
    + ";\n"
  )
  print(f"[export] wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
  main()
