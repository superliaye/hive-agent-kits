// SettingRow — the disciplined building block for a settings list that must stay
// scannable at 20-30+ rows: a compact `.appearance-row` (label + control slot)
// with the row's explanation folded behind an accessible info icon rather than
// spent as always-visible prose.
//
// Accessibility: the explanation is rendered TWICE for two distinct consumers.
//   1. An always-present visually-hidden node (`.sr-only`) carries the text in
//      the accessibility tree at all times; its id is handed to the control via
//      `describedById` so a screen-reader user who tabs straight onto the toggle
//      hears the consequence in the control's own description — even though no
//      tooltip is visually open. (A `hidden`/`display:none` popover is pruned
//      from the a11y tree, so the visible tooltip alone cannot serve this.)
//   2. A visible `role="tooltip"` popover, shown only on hover/focus, is the
//      sighted affordance. It costs zero vertical space at rest.
//
// The hover/focus open-state is owned by the `.setting-info` wrapper (which
// contains both the trigger and the popover), so moving the pointer from the
// icon across the small gap onto the tooltip keeps it open — a single open
// authority, not racing per-element handlers.

import { type ReactNode, useId, useState } from "react";

export function SettingRow({
  label,
  explanation,
  controlDisabled = false,
  children,
}: {
  label: string;
  /** The row's explanation, surfaced behind the info icon (and to AT). */
  explanation: ReactNode;
  /** Dim the label + control (control still owns its own `disabled`). */
  controlDisabled?: boolean;
  /**
   * The control slot. Receives the id of the label (bind via `id`, so the
   * `<label>` resolves) and the id of the always-present description node (bind
   * via `aria-describedby`, so the control announces the explanation).
   */
  children: (args: { controlId: string; describedById: string }) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const controlId = `${id}-control`;
  const tipId = `${id}-tip`;
  const descId = `${id}-desc`;

  return (
    <div className={`appearance-row${controlDisabled ? " appearance-row--control-disabled" : ""}`}>
      <div className="appearance-row-label">
        <span className="setting-row-label-line">
          <label htmlFor={controlId}>{label}</label>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hover is a pointer-only
              progressive enhancement on a presentational wrapper — the interactive
              element is the <button> inside, and keyboard users open/close via its
              focus/blur. The wrapper owns open-state so the gap between trigger and
              popover stays inside one hover region. */}
          <span
            className="setting-info"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <button
              type="button"
              className="setting-info-trigger"
              aria-label={`About ${label}`}
              aria-describedby={tipId}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && open) {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            >
              <span aria-hidden="true">i</span>
            </button>
            <span
              id={tipId}
              role="tooltip"
              className="setting-info-tip"
              data-testid="setting-info-tip"
              hidden={!open}
            >
              {explanation}
            </span>
          </span>
        </span>
      </div>
      <div className="appearance-row-control">{children({ controlId, describedById: descId })}</div>
      {/* Always in the a11y tree so the control's aria-describedby resolves. */}
      <span id={descId} className="sr-only" data-testid="setting-info-desc">
        {explanation}
      </span>
    </div>
  );
}
