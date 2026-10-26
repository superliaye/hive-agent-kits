import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  type AddSourceError,
  type AddSourceResult,
  type ApiConfig,
  api,
  type TileSummary,
} from "../api.ts";
import { AddSourceStatus } from "./AddSourceStatus.tsx";

type AddTileMutation = UseMutationResult<AddSourceResult, AddSourceError, string>;

// The page owns the mutation so its banner survives the shelf moving between
// the empty state and the Sources panel after the first add.
export function useAddTile(apiConfig: ApiConfig, onChanged: () => void): AddTileMutation {
  return useMutation<AddSourceResult, AddSourceError, string>({
    mutationFn: (tileId) => api.addTile(apiConfig, tileId),
    onSuccess: onChanged,
    onError: (error) => {
      // The Daemon committed the Source, or it already had it: either way the
      // shelf and Overview are stale.
      if (error.cause.kind === "malformed-success" || error.cause.kind === "duplicate") {
        onChanged();
      }
    },
  });
}

export function useTiles(apiConfig: ApiConfig): UseQueryResult<TileSummary[]> {
  return useQuery({
    queryKey: ["tiles"],
    queryFn: () => api.listTiles(apiConfig),
  });
}

export function TileShelf({
  apiConfig,
  addTile,
  disabled,
}: {
  apiConfig: ApiConfig;
  addTile: AddTileMutation;
  disabled: boolean;
}): JSX.Element | null {
  const tilesQuery = useTiles(apiConfig);
  const tiles = tilesQuery.data ?? [];
  if (tilesQuery.isSuccess && tiles.length === 0) return null;
  return (
    <section className="tile-shelf" data-testid="tile-shelf" aria-labelledby="tile-shelf-title">
      <div className="tile-shelf-head">
        <h2 className="tile-shelf-title" id="tile-shelf-title">
          Tiles
        </h2>
        <span className="tile-shelf-meta">Curated Sources. Adding one syncs it.</span>
      </div>
      {tilesQuery.isLoading && <span className="tile-shelf-note">Loading Tiles…</span>}
      {tilesQuery.isError && (
        <span className="tile-shelf-note" data-testid="tile-shelf-error">
          Tiles are unavailable.
        </span>
      )}
      {tiles.length > 0 && (
        <ul className="tile-grid">
          {tiles.map((tile) => (
            <TileCard
              key={tile.id}
              tile={tile}
              onAdd={() => addTile.mutate(tile.id)}
              adding={addTile.isPending && addTile.variables === tile.id}
              disabled={disabled || addTile.isPending}
            />
          ))}
        </ul>
      )}
      <AddSourceStatus state={addTile} />
    </section>
  );
}

function TileCard({
  tile,
  onAdd,
  adding,
  disabled,
}: {
  tile: TileSummary;
  onAdd: () => void;
  adding: boolean;
  disabled: boolean;
}): JSX.Element {
  return (
    <li className="tile-card" data-testid={`tile-${tile.id}`}>
      <div className="tile-card-head">
        <span className="tile-card-label">{tile.label}</span>
        {tile.sourceId !== null ? (
          <span className="tile-added" data-testid={`tile-added-${tile.id}`}>
            Added
          </span>
        ) : (
          <button
            type="button"
            className="button ghost tile-add"
            onClick={onAdd}
            disabled={disabled}
            aria-label={`Add ${tile.label}`}
            data-testid={`tile-add-${tile.id}`}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        )}
      </div>
      <p className="tile-card-desc">{tile.description}</p>
      <div className="tile-card-badges">
        <span className="badge badge-source" data-testid={`tile-recipe-${tile.id}`}>
          {tile.recipe.label}
        </span>
        {tile.recipe.unit === "whole" && (
          <span className="badge badge-whole" data-testid={`tile-whole-${tile.id}`}>
            Installs whole
          </span>
        )}
      </div>
    </li>
  );
}
