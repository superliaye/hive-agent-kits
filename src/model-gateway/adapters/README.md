# Writing a ModelGateway adapter

An adapter is a small object that translates one provider's wire shape into
`GatewayEvent`s. See `docs/adr/0005-model-gateway-design.md` for the full event
taxonomy.

## Contract

```ts
type GatewayAdapter = {
  providers: string[];                                    // ["anthropic", "anthropic-direct", ...]
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
};
```

Register on import-side-effect, then `resolve("provider/model")` finds you:

```ts
import { registerAdapter } from "../index.ts";
import { myAdapter } from "./my-adapter.ts";
registerAdapter(myAdapter);
```

## Rules

- **Always terminate.** Every stream must end with exactly one `{type: "done"}`.
  If you emit an `error`, follow it with `done` (typically `finishReason: "error"`).
- **One terminal path on abort.** When `input.signal` aborts, emit
  `{type: "done", finishReason: "cancelled"}` and stop. No further events.
- **`blockIndex` is per-block.** Increment when you start a new content block;
  reuse the same index for `*_start`, `*_delta`, `*_end` of one block.
- **Emit `usage` exactly once**, right before `done`. Skip if you can't get it.
- **Surface errors via the stream, not by throwing.** Adapters do not throw out
  of `complete()`; they `yield {type: "error", ...}` and end.
- **Don't retry inside the adapter.** The Run executor owns retry policy.
- **Auth is the caller's job.** `AuthInput` arrives resolved. You read it.
  - For `kind: "apiKey"` you just use the key.
  - For `kind: "oauth"` you may need to refresh the access token (typical:
    pi-ai's `getOAuthApiKey` does this internally). When refresh produces
    new credentials, you MUST `await auth.onRefresh(newCreds)` before
    completing the call — that's how the Secrets module learns to persist
    the new tokens. Skipping the callback works in-memory but forces a
    re-login on every daemon restart. See `AuthInput.onRefresh` JSDoc.

## Reference adapters

- `claude-cli.ts` — spawns the local `claude` CLI in non-interactive mode and
  parses its `stream-json` output. Auth is delegated to the CLI.
- `fake.ts` — emits a scripted event list for tests.
