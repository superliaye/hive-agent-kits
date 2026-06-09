// InlineTitle — a reusable inline-editable title. Double-click (or an external
// trigger via `editing`/`onEditingChange`) swaps the static text for an input;
// Enter or blur commits, Escape cancels. Used in two places: the chat header
// title and the nav-row "Rename" target.

import { useEffect, useRef, useState } from "react";

export function InlineTitle({
  value,
  placeholder,
  editing,
  onEditingChange,
  onCommit,
  className,
  inputClassName,
  ariaLabel,
}: {
  // The current title text to display.
  value: string;
  // Shown (muted) when `value` is empty.
  placeholder: string;
  // Controlled edit state — lets the context-menu "Rename" open the editor.
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  // Commit a non-empty, changed title. No-ops upstream if unchanged/empty.
  onCommit: (next: string) => void;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-seed the draft each time we enter edit mode so it reflects the latest
  // value (e.g. after an auto-title pass updated it while not editing).
  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Focus + select on the next frame once the input is mounted.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  function commit(): void {
    const next = draft.trim();
    onEditingChange(false);
    if (next && next !== value) onCommit(next);
  }

  function cancel(): void {
    setDraft(value);
    onEditingChange(false);
  }

  if (!editing) {
    return (
      <span
        className={className}
        onDoubleClick={() => onEditingChange(true)}
        title="Double-click to rename"
        data-testid="inline-title-display"
      >
        {value || <span className="inline-title-placeholder">{placeholder}</span>}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className={inputClassName ?? "inline-title-input"}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel ?? "Edit title"}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The editor owns the keyboard while open; stop keys from bubbling to an
        // interactive ancestor (e.g. the nav row's role="button" onKeyDown, which
        // would otherwise preventDefault Space and re-fire select on Enter).
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      data-testid="inline-title-input"
    />
  );
}
