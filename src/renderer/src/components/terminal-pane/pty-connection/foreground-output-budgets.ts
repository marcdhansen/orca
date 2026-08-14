export const FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS = 2048
export const FOREGROUND_INTERACTIVE_REDRAW_CHARS = 128 * 1024
export const FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS = 150
// Why: a submit repaint can take longer than one keystroke echo to fully
// arrive, so a synchronized frame that *began* this close to a keystroke stays
// latency-sensitive even when ConPTY splits its end marker past the redraw
// window — the keystroke is the "user is here, paint now" signal, not the
// late closing chunk.
export const FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS = 400
// Why: OpenTUI can emit many tiny redraws that each look interactive but
// collectively starve timers unless foreground writes have a rolling budget.
export const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024
export const FOREGROUND_BUDGET_WINDOW_MS = 500
export const INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS = 32 * 1024
export const FOREGROUND_GRID_DRIFT_CHECK_MIN_MS = 250
