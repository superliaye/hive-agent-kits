// MessageComposer — multi-line textarea + Send button. Enter sends;
// Shift+Enter inserts a newline. Disables while a Run is in flight, with
// a Cancel button as the escape hatch.

import { useState } from "react";

export function MessageComposer({
  inFlight,
  onSend,
  onCancel,
}: {
  inFlight: boolean;
  onSend: (text: string) => void | Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const canSend = !inFlight && text.trim().length > 0;

  async function submit(): Promise<void> {
    const v = text.trim();
    if (!v || inFlight) return;
    setText("");
    await onSend(v);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer" data-testid="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          inFlight ? "Run in progress…" : "Type a message (Enter to send, Shift+Enter for newline)"
        }
        rows={3}
        disabled={inFlight}
        data-testid="composer-input"
      />
      <div className="composer-actions">
        {inFlight ? (
          <button
            type="button"
            className="button ghost"
            onClick={onCancel}
            data-testid="composer-cancel"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() => void submit()}
            disabled={!canSend}
            data-testid="composer-send"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
