# gt_config_store.py
# Load/save helpers for state.gt_config — the mutable, persisted GT
# Acquisition tuning knobs editable from the ML Fine Tuning page.
#
# Mirrors faiss_config_store.py's exact pattern.

import os
import json
import logging

import state

logger = logging.getLogger("ml_service.gt_config")

from paths import data_path

CONFIG_PATH = data_path("gt_config.json")

DEFAULTS = {
    "frame_skip":              10,
    "target_imgs_per_person":  10,
    "cluster_threshold":       0.45,
    "min_samples":             3,
    "det_size":                320,
    "merge_threshold":         0.75,
    "nms_iou_thresh":          0.35,
    "det_score_floor":         0.5,
    "new_person_timeout":      60,
    # GT acquisition only — see the note in state.py. Renamed from the old
    # "camera_switch_sec": that key was shared with the live attendance
    # pipeline but only ever honoured there, so a value saved here silently
    # did nothing for GT. The rename means a stale camera_switch_sec in an
    # existing gt_config.json is dropped by the known-keys filter below
    # instead of suddenly shortening GT sub-runs to it.
    "gt_camera_switch_sec":    300,
    "top_n":                   10,
    "embed_n":                 5,
    "max_imgs_per_run":        0,
}


def load_gt_config():
    """
    Load persisted GT Acquisition config into state.gt_config, if a file
    exists. Missing/corrupt file → keep the in-memory defaults (already set
    in state.py) and write them out so the file exists going forward.
    """
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                saved = json.load(f)
            with state.gt_config_lock:
                # Only keys still in DEFAULTS survive — a retired key left in an
                # older gt_config.json (e.g. the pre-split camera_switch_sec) is
                # dropped rather than carried forward forever.
                merged = {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}
                state.gt_config.clear()
                state.gt_config.update(merged)
            logger.info(f"[GTConfig] Loaded from {CONFIG_PATH}: {state.gt_config}")
            return
        except Exception as e:
            logger.warning(f"[GTConfig] Failed to read {CONFIG_PATH}: {e} — using defaults")

    save_gt_config()


def save_gt_config():
    """Write the current state.gt_config to disk."""
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with state.gt_config_lock:
            snapshot = dict(state.gt_config)
        with open(CONFIG_PATH, "w") as f:
            json.dump(snapshot, f, indent=2)
    except Exception as e:
        logger.warning(f"[GTConfig] Failed to save {CONFIG_PATH}: {e}")


def update_gt_config(updates: dict):
    """
    Apply a partial update to state.gt_config (only known keys are
    accepted) and persist it. Returns the resulting full config dict.
    """
    with state.gt_config_lock:
        for key in DEFAULTS:
            if key in updates:
                state.gt_config[key] = updates[key]
        snapshot = dict(state.gt_config)
    save_gt_config()
    return snapshot
