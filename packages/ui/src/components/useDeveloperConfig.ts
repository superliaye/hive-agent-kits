// useDeveloperConfig — the single data-layer seam for the `developer` config
// slice (`allowRealHomeDeploy`). Both surfaces that touch the slice consume this:
// DeveloperSettings (the toggle) and KitDeployPage (its persistent armed banner).
// Owning the slice here keeps the cross-surface live-update guarantee by
// construction: a write optimistically sets the shared query cache, so the
// permanently-mounted Deploy banner reflects a toggle made in Settings without a
// manual invalidate.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiConfig, api, type DeveloperConfig } from "../api.ts";

// The one place the slice's react-query key is defined. No inline ["developer"]
// literals in components.
export const DEVELOPER_QUERY_KEY = ["developer"] as const;

export type UseDeveloperConfig = {
  // True once a read has settled (success OR error) — the toggle stays disabled
  // until then. Fail-closed: on a read error `armed` is false.
  loaded: boolean;
  // The slice's `allowRealHomeDeploy`, with the fail-closed default.
  armed: boolean;
  setAllowRealHomeDeploy: (next: boolean) => void;
  // The last write's error, surfaced as the toggle's save-error banner.
  saveError: Error | null;
};

export function useDeveloperConfig(apiConfig: ApiConfig): UseDeveloperConfig {
  const qc = useQueryClient();

  const query = useQuery<DeveloperConfig>({
    queryKey: DEVELOPER_QUERY_KEY,
    queryFn: () => api.getDeveloper(apiConfig),
  });

  const mutation = useMutation<
    DeveloperConfig,
    Error,
    DeveloperConfig,
    { previous: DeveloperConfig | undefined }
  >({
    mutationFn: (value: DeveloperConfig) => api.putDeveloper(apiConfig, value),
    // Optimistic: set the shared cache immediately. The Deploy banner reads the
    // same key, so it arms/disarms live — no manual invalidate.
    onMutate: async (value: DeveloperConfig) => {
      await qc.cancelQueries({ queryKey: DEVELOPER_QUERY_KEY });
      const previous = qc.getQueryData<DeveloperConfig>(DEVELOPER_QUERY_KEY);
      qc.setQueryData<DeveloperConfig>(DEVELOPER_QUERY_KEY, value);
      return { previous };
    },
    // Roll back to the pre-write snapshot on failure.
    onError: (_err, _value, context) => {
      if (context) qc.setQueryData<DeveloperConfig>(DEVELOPER_QUERY_KEY, context.previous);
    },
    // The single reconciliation point: invalidate so a fresh GET replaces the
    // optimistic value with the server's authoritative one (the PUT echo is
    // intentionally not written into the cache).
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DEVELOPER_QUERY_KEY });
    },
  });

  const loaded = query.isSuccess || query.isError;
  const armed = query.data?.allowRealHomeDeploy ?? false;

  return {
    loaded,
    armed,
    setAllowRealHomeDeploy: (next: boolean) => mutation.mutate({ allowRealHomeDeploy: next }),
    saveError: mutation.error,
  };
}
