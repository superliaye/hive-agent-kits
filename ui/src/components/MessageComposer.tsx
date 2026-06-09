// MessageComposer — multi-line textarea + Send button. Enter sends;
// Shift+Enter inserts a newline. Disables while a Run is in flight, with
// a Cancel button as the escape hatch. A model picker selects which model
// the message runs on; choosing one also makes it the agent's sticky default.
// An effort picker, next to it, selects the thinking/reasoning effort — its
// options are only the levels the selected model supports.

import { useState } from "react";
import type { AvailableModel, ThinkingEffort } from "../api.ts";

// Sentinel option value: selecting it navigates to Settings → Secrets rather
// than picking a model. No slash, so it can't collide with a "provider/model".
const ADD_MODELS = "__add_models__";

// Display labels for the effort levels. Keys are the pi-ai-native vocabulary.
const EFFORT_LABEL: Record<ThinkingEffort, string> = {
  off: "Thinking: off",
  minimal: "Thinking: minimal",
  low: "Thinking: low",
  medium: "Thinking: medium",
  high: "Thinking: high",
  xhigh: "Thinking: xhigh",
};

export function MessageComposer({
  inFlight,
  onSend,
  onCancel,
  models,
  selectedModel,
  onSelectModel,
  onAddModels,
  efforts,
  selectedEffort,
  onSelectEffort,
}: {
  inFlight: boolean;
  onSend: (text: string) => void | Promise<void>;
  onCancel: () => void;
  models: AvailableModel[];
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onAddModels: () => void;
  // The selected model's supported effort levels, in canonical order. May omit
  // "off" for always-reasoning models; empty when no model is selected. The
  // picker hides whenever there is no real (non-"off") level.
  efforts: ThinkingEffort[];
  selectedEffort: ThinkingEffort | null;
  onSelectEffort: (effort: ThinkingEffort) => void;
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

  // The current selection may be the agent's harness default, which isn't
  // necessarily a configured+routable model — show it (disabled) so the picker
  // reflects reality and prompts the user to pick a runnable one.
  const selectionKnown = selectedModel !== null && models.some((m) => m.model === selectedModel);

  // Render the effort picker only when the model exposes a real reasoning level.
  // A model whose only supported level is "off" (a non-reasoning model) gets no
  // picker — there is nothing to choose.
  const hasRealEffort = efforts.some((eff) => eff !== "off");

  function onPick(value: string): void {
    if (value === ADD_MODELS) {
      onAddModels();
      return;
    }
    onSelectModel(value);
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
        <div className="composer-run-settings">
          <select
            className="composer-model-picker"
            value={selectedModel ?? ""}
            onChange={(e) => onPick(e.target.value)}
            disabled={inFlight}
            data-testid="composer-model-picker"
            aria-label="Model"
          >
            {selectedModel === null && (
              <option value="" disabled>
                {models.length === 0 ? "No models configured" : "Select a model…"}
              </option>
            )}
            {selectedModel !== null && !selectionKnown && (
              <option value={selectedModel} disabled>
                {selectedModel} (unavailable)
              </option>
            )}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.label ?? m.model}
              </option>
            ))}
            <option value={ADD_MODELS}>+ Add models in Settings…</option>
          </select>
          {hasRealEffort && (
            <select
              className="composer-effort-picker"
              value={selectedEffort ?? ""}
              onChange={(e) => {
                // The option values are exactly `efforts` (all ThinkingEffort),
                // so resolve the picked string back to its typed member rather
                // than casting.
                const picked = efforts.find((eff) => eff === e.target.value);
                if (picked) onSelectEffort(picked);
              }}
              disabled={inFlight}
              data-testid="composer-effort-picker"
              aria-label="Thinking effort"
            >
              {efforts.map((eff) => (
                <option key={eff} value={eff}>
                  {EFFORT_LABEL[eff]}
                </option>
              ))}
            </select>
          )}
        </div>
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
