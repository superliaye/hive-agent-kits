// MessageList — renders persisted thread messages + the in-flight
// assistant's pending blocks. Anthropic-flavored content: text, thinking
// (collapsed disclosure), tool_use (card with pending badge), tool_result.

import type { ContentBlock, ThreadMessage } from "../api.ts";
import type { PendingAssistant } from "../hooks/useChatThread.ts";

export function MessageList({
  messages,
  pending,
  runError,
}: {
  messages: ThreadMessage[];
  pending: PendingAssistant | null;
  runError: { code: string; message: string } | null;
}): JSX.Element {
  return (
    <div className="message-list" data-testid="message-list">
      {messages.length === 0 && !pending && (
        <p className="empty">Start the conversation by typing below.</p>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} role={m.role} content={m.content} />
      ))}
      {pending && (
        <div className="message message-assistant message-pending" data-testid="pending-assistant">
          <div className="message-role">assistant · streaming…</div>
          <div className="message-blocks">
            {pending.blocks.map((b, i) => {
              // blocks are append-only during a Run — index is stable.
              if (b.kind === "text") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
                  <div key={`p-text-${i}`} className="block-text">
                    {b.text}
                    <span className="cursor-blink">▍</span>
                  </div>
                );
              }
              if (b.kind === "thinking") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
                  <details key={`p-think-${i}`} className="block-thinking">
                    <summary>Thoughts (streaming)</summary>
                    <div className="block-thinking-body">{b.thinking}</div>
                  </details>
                );
              }
              return (
                <ToolUseCard
                  key={`p-tool-${b.id}`}
                  toolId={b.id}
                  name={b.name}
                  args={b.args}
                  argsDelta={b.argsDelta}
                  pending
                />
              );
            })}
          </div>
        </div>
      )}
      {runError && (
        <div className="banner-error" data-testid="run-error">
          <strong>Run {runError.code}:</strong> {runError.message}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: ContentBlock[];
}): JSX.Element {
  return (
    <div className={`message message-${role}`} data-testid={`message-${role}`}>
      <div className="message-role">{role}</div>
      <div className="message-blocks">{content.map((b, i) => renderBlock(b, i))}</div>
    </div>
  );
}

function renderBlock(b: ContentBlock, i: number): JSX.Element | null {
  if (b.type === "text") {
    return (
      <div key={`text-${i}`} className="block-text">
        {b.text}
      </div>
    );
  }
  if (b.type === "thinking") {
    return (
      <details key={`think-${i}`} className="block-thinking">
        <summary>Thoughts</summary>
        <div className="block-thinking-body">{b.thinking}</div>
      </details>
    );
  }
  if (b.type === "tool_use") {
    return (
      <ToolUseCard
        key={`tool-${b.id}-${i}`}
        toolId={b.id}
        name={b.name}
        args={b.input}
        pending={false}
      />
    );
  }
  if (b.type === "tool_result") {
    return (
      <div
        key={`toolres-${i}`}
        className={`block-tool-result${b.is_error ? " block-tool-result-error" : ""}`}
      >
        <div className="meta">tool_result · {b.tool_use_id}</div>
        <pre className="block-tool-result-body">
          {typeof b.content === "string"
            ? b.content
            : b.content
                .map((c: ContentBlock) => (c.type === "text" ? c.text : `[${c.type} block]`))
                .join("\n")}
        </pre>
      </div>
    );
  }
  if (b.type === "image") {
    return (
      <div key={`img-${i}`} className="block-image meta">
        [image block · {b.source.media_type ?? "unknown"}]
      </div>
    );
  }
  return null;
}

function ToolUseCard({
  toolId,
  name,
  args,
  argsDelta,
  pending,
}: {
  toolId: string;
  name: string;
  args: unknown;
  argsDelta?: string;
  pending: boolean;
}): JSX.Element {
  let argsText: string;
  try {
    argsText = JSON.stringify(args, null, 2);
  } catch {
    argsText = String(args);
  }
  return (
    <div className="block-tool-use" data-testid={`tool-use-${toolId}`}>
      <div className="block-tool-use-header">
        <span className="block-tool-use-name">{name}</span>
        <span className={`badge ${pending ? "badge-runtime" : "badge-bundled"}`}>
          {pending ? "calling…" : "pending dispatch"}
        </span>
        <span className="meta">id: {toolId}</span>
      </div>
      <pre className="block-tool-use-args">
        {pending && argsDelta && !argsText ? argsDelta : argsText}
      </pre>
    </div>
  );
}
