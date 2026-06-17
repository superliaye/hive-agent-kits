// Pattern-match redaction backstop per ADR-0004.
// Walks any value recursively; masks strings matching known secret shapes
// with `[REDACTED:<shape-name>]`. Belt-and-suspenders behind emitter-side
// redaction — modules are still expected to keep raw secrets out of payloads.

type RedactPattern = {
  name: string;
  regex: RegExp;
  // Optional custom replacer for patterns where we want to preserve part
  // of the match (e.g., the scheme and host of a URL with embedded creds).
  // Default is full replacement with `[REDACTED:<name>]`.
  replacer?: (match: string, ...groups: string[]) => string;
};

// Patterns intentionally omit trailing `\b` — token boundary may abut other
// word characters (e.g. `ghp_..._test`), and the goal is to redact rather
// than precisely terminate. Anthropic listed first because its `sk-ant-`
// prefix is a strict subset of OpenAI's `sk-` shape; redacting in this
// order avoids double-masking.
const PATTERNS: readonly RedactPattern[] = [
  { name: "anthropic-api", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-api", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", regex: /\bgh[psorau]_[A-Za-z0-9_]{20,}/g },
  { name: "gitlab-pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", regex: /\bxox[bpoa]-[A-Za-z0-9-]{20,}/g },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}/g },
  { name: "google-api", regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  // JWT — three base64url segments separated by dots. Common in auth headers
  // and chat-pasted snippets.
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // URL credentials — `scheme://user:password@host`. Redact only the
  // password portion; keep scheme/user/host visible for debug context.
  {
    name: "url-password",
    regex:
      /(\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|smtp|http|https|ftp|ssh):\/\/[^:/@\s]+:)[^@/\s]+@/g,
    replacer: (_match, prefix) => `${prefix}[REDACTED:url-password]@`,
  },
];

export function redactString(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    if (p.replacer) {
      out = out.replace(p.regex, p.replacer);
    } else {
      out = out.replace(p.regex, `[REDACTED:${p.name}]`);
    }
  }
  return out;
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v);
    }
    return out as T;
  }
  return value;
}
