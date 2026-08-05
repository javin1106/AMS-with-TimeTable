// client/src/attendancemodule/gtOptions.js
// Canonical option sets for the GT Acquisition tuning knobs.
//
// Shared by the ML Fine Tuning page (which saves them via POST /gt-config)
// and the GT Acquisition page (which prefills from GET /gt-config and lets
// the user override per run). Keeping a single copy stops the two lists
// drifting: the acquisition page used to offer a narrower set, so a value
// chosen in ML Fine Tuning arrived with no button showing as selected.
//
// Every value here must stay inside the ranges validated by the ML service
// in rtsp_routes.py :: update_gt_config_ep(), or saving will 400.

export const GT_OPTIONS = {
    frame_skip:             [1, 3, 5, 10, 15, 20, 30],
    target_imgs_per_person: [5, 8, 10, 15, 20, 30],
    cluster_threshold:      [0.35, 0.40, 0.45, 0.50, 0.55, 0.60],
    min_samples:            [2, 3, 5, 7, 10],
    det_size:               [320, 640],
    merge_threshold:        [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90],
    nms_iou_thresh:         [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50],
    det_score_floor:        [0.30, 0.40, 0.50, 0.60, 0.70],
    new_person_timeout:     [15, 30, 45, 60, 90, 120, 180],
    embed_n:                [3, 4, 5, 7, 10],
    // GT acquisition only. Minutes, not seconds: each switch ends a sub-run
    // (stream reconnect + final clustering pass), so short intervals spend more
    // time switching than capturing. Live attendance has its own, much shorter
    // interval — see ATTEND_OPTIONS.camera_switch_sec in MLFineTuning.jsx.
    gt_camera_switch_sec:   [60, 120, 180, 240, 300, 450, 600, 900],
    max_imgs_per_run:       [0, 1, 2, 3, 4, 5, 8, 10],
};

// Largest offered embed_n that still fits within `target` — used when the
// target is lowered, so embed_n is pulled down to a value the ML service
// will accept (it rejects embed_n > target_imgs_per_person) *and* that the
// dropdown can actually render as selected.
export function clampEmbedN(embedN, target) {
    if (embedN <= target) return embedN;
    const fits = GT_OPTIONS.embed_n.filter(v => v <= target);
    return fits.length ? Math.max(...fits) : GT_OPTIONS.embed_n[0];
}
