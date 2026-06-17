// Shared, pure tier-precedence for the composer's selection axes
// (model / effort / backend). Each axis resolves the same way:
//
//   in-session pick  >  agent default (if still offerable)  >  axis fallback
//
// Before this helper, ChatPage hand-reimplemented that ordering once per axis,
// which let the three tiers drift. The ordering lives here once; the per-axis
// validity/offerability rules and the fallback are passed in, so each axis keeps
// its own branding (model validates against runnable models, effort against the
// selected model's supported levels, backend against the offerable backends).
//
// The view-side offerability fallback — showing the axis fallback when the
// stored default cannot currently run (e.g. backend → `native`) — is preserved
// here for every axis; it is established, accepted precedent and stays
// consistent across all three.

type ResolveAxisInput<V> = {
  // The explicit in-session pick (null until the user picks).
  pick: V | null;
  // Whether a non-null pick is currently valid/offerable. Model and backend take
  // the pick unconditionally (always-true); effort validity is checked against
  // the selected model's supported levels.
  pickValid: (pick: V) => boolean;
  // The agent's stored default for this axis (null when unset).
  def: V | null;
  // Whether the stored default is currently offerable (runnable model / valid
  // effort level / installed-and-healthy backend).
  defOfferable: (def: V) => boolean;
  // The axis fallback when neither pick nor default applies (latest runnable
  // model, the model's first supported effort, or `native` for backend).
  fallback: V | null;
};

export function resolveAxis<V>({
  pick,
  pickValid,
  def,
  defOfferable,
  fallback,
}: ResolveAxisInput<V>): V | null {
  if (pick !== null && pickValid(pick)) return pick;
  if (def !== null && defOfferable(def)) return def;
  return fallback;
}
