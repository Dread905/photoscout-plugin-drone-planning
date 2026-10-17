/**
 * The plugin's stylesheet, injected on activate. It uses the app's colour variables (with fallbacks), and the
 * `dp-` prefix keeps it from touching anything else.
 */
export const DRONE_CSS = `
.dp-corner, .dp-details { color: var(--text, #e9ecf3); font-size: 13px; line-height: 1.4; }
.dp-corner { background: var(--glass, rgba(23,26,33,.95)); border: 1px solid var(--border, #2a2f3b); border-radius: var(--radius, 12px); padding: 12px; width: min(340px, calc(100vw - 32px)); max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.dp-details { padding: 12px 16px 24px; display: flex; flex-direction: column; gap: 10px; }
.dp-details h2 { font-size: 16px; margin: 0; }
.dp-details h3 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #98a1b3); }
.dp-details h4 { font-size: 13px; margin: 6px 0 2px; }
.dp-details p, .dp-corner p { margin: 4px 0; }
.dp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
.dp-head > strong, .dp-head > h2 { margin-right: auto; }
.dp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dp-summary { font-weight: 600; }
.dp-muted { color: var(--muted, #98a1b3); font-size: 12px; }
.dp-block { display: block; }
.dp-btn { background: var(--panel-2, #1d212b); color: inherit; border: 1px solid var(--border, #2a2f3b); border-radius: var(--radius-xs, 6px); padding: 4px 10px; cursor: pointer; font: inherit; }
.dp-btn:hover:not(:disabled) { background: var(--panel-hover, #252b38); }
.dp-btn:disabled { opacity: .6; cursor: default; }
.dp-btn--primary { background: var(--accent-soft, rgba(245,166,35,.15)); border-color: var(--accent, #f5a623); }
.dp-radius { display: flex; flex-direction: column; gap: 4px; }
.dp-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid transparent; background: var(--panel-2, #1d212b); }
.dp-badge--restriction { background: rgba(239,68,68,.2); border-color: #ef4444; color: #fca5a5; }
.dp-badge--caution { background: rgba(234,179,8,.18); border-color: #eab308; color: #fde68a; }
.dp-badge--not-checked, .dp-badge--stale { background: rgba(148,163,184,.18); border-color: #94a3b8; }
.dp-badge--responsibility { background: rgba(76,195,255,.15); border-color: var(--blue, #4cc3ff); }
.dp-badge--info { background: rgba(74,222,128,.12); border-color: var(--green, #4ade80); }
.dp-badge--outside, .dp-badge--rule, .dp-badge--authority { color: var(--muted, #98a1b3); border-color: var(--border, #2a2f3b); font-weight: 500; }
.dp-alert { border-left: 3px solid; padding: 4px 8px; border-radius: 4px; background: var(--panel-2, #1d212b); }
.dp-alert--info { border-color: var(--blue, #4cc3ff); }
.dp-alert--warn { border-color: var(--accent, #f5a623); }
.dp-alert--error { border-color: var(--red, #f87171); }
.dp-chips { display: flex; flex-direction: column; gap: 4px; }
.dp-chip { background: var(--panel-2, #1d212b); border-radius: var(--radius-xs, 6px); padding: 4px 8px; }
.dp-chip__label { color: var(--muted, #98a1b3); margin-right: 6px; font-size: 11px; text-transform: uppercase; }
.dp-card { background: var(--panel-2, #1d212b); border: 1px solid var(--border, #2a2f3b); border-left-width: 4px; border-radius: var(--radius-sm, 8px); padding: 8px 10px; margin-bottom: 8px; }
.dp-card--restriction { border-left-color: #ef4444; }
.dp-card--caution { border-left-color: #eab308; }
.dp-card--not_checked { border-left-color: #94a3b8; }
.dp-card--info { border-left-color: var(--green, #4ade80); }
.dp-card__head { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-action { font-size: 12px; }
.dp-check { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border, #2a2f3b); cursor: pointer; }
.dp-check code { font-size: 11px; color: var(--muted, #98a1b3); }
.dp-sources { margin: 0; padding-left: 18px; }
.dp-disclaimer { font-size: 12px; color: var(--muted, #98a1b3); border-top: 1px solid var(--border, #2a2f3b); padding-top: 8px; margin-top: 6px; }
.drone-popup { color: #111; font-size: 12px; line-height: 1.4; max-width: 280px; }
.drone-popup-alert { color: #b91c1c; font-weight: 600; }
.drone-popup-small { color: #555; font-size: 11px; }
@media (max-width: 820px) { .dp-corner { max-height: 45vh; } }
`;
