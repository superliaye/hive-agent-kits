// ThreadContextMenu — a positioned right-click menu for a nav thread row.
// Exactly four actions: Delete / Archive / Mark as not read / Rename. Closes on
// outside-click and Escape; fully keyboard-operable (arrow navigation, Enter to
// activate, Escape to close). No "reset" item by design.

import { useEffect, useRef } from "react";

export type ThreadMenuAction = "delete" | "archive" | "unread" | "rename";

const ITEMS: Array<{ action: ThreadMenuAction; label: string }> = [
  { action: "rename", label: "Rename" },
  { action: "archive", label: "Archive" },
  { action: "unread", label: "Mark as not read" },
  { action: "delete", label: "Delete" },
];

export function ThreadContextMenu({
  x,
  y,
  onAction,
  onClose,
}: {
  // Viewport coordinates of the right-click.
  x: number;
  y: number;
  onAction: (action: ThreadMenuAction) => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Focus the menu on open so keyboard navigation works immediately.
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, []);

  // Outside-click + Escape close. Pointerdown (not click) so the menu closes
  // before a downstream click handler on the row fires.
  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function focusSibling(current: HTMLButtonElement, dir: 1 | -1): void {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const idx = buttons.indexOf(current);
    const next = buttons[(idx + dir + buttons.length) % buttons.length];
    next?.focus();
  }

  return (
    // role=menu with roving focus across role=menuitem buttons.
    <div
      ref={menuRef}
      className="context-menu"
      style={{ top: y, left: x }}
      role="menu"
      aria-label="Thread actions"
      data-testid="thread-context-menu"
    >
      {ITEMS.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`context-menu-item${item.action === "delete" ? " danger" : ""}`}
          onClick={() => {
            onAction(item.action);
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusSibling(e.currentTarget, 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusSibling(e.currentTarget, -1);
            }
          }}
          data-testid={`thread-menu-${item.action}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
