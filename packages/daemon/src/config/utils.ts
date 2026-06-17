// Deep-merge user values over defaults; deep-equality for change diffing.
// Local to the Config module; not exported as a general utility.

export function deepMerge<T>(defaults: T, user: unknown): T {
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) {
    return user === undefined ? defaults : (user as T);
  }
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return user === undefined ? defaults : (user as T);
  }
  const out: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(defaults as Record<string, unknown>),
    ...Object.keys(user as Record<string, unknown>),
  ]);
  for (const k of keys) {
    out[k] = deepMerge(
      (defaults as Record<string, unknown>)[k],
      (user as Record<string, unknown>)[k],
    );
  }
  return out as T;
}

// Order-independent deep equality. Used for diffing top-level keys after a
// reload. JSON stringify is fast and sufficient for our config shapes
// (no Dates, Maps, Sets, or NaN).
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}
