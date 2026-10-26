import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type AddSourceError,
  type AddSourceResult,
  type ApiConfig,
  api,
  type OverviewMirror,
  type OverviewSource,
  openUrl,
  type TileSummary,
} from "../api.ts";
import { AddSourceStatus } from "./AddSourceStatus.tsx";

type AddTileMutation = UseMutationResult<AddSourceResult, AddSourceError, string>;

function useAddTile(apiConfig: ApiConfig, onChanged: () => void): AddTileMutation {
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

// What the shelf needs to remove a Source. The page owns the mutation, because
// removing turns off the Capabilities only that Source provides.
export type SourceRemoval = {
  remove: (source: OverviewSource) => void;
  pendingId: string | undefined;
  failedId: string | undefined;
  // How many selected Capabilities turn off with the Source.
  turnsOff: (sourceId: string) => number;
};

type Recipe = NonNullable<OverviewSource["recipe"]>;

// Every Source in one grid, added ones first: the added Tiles, then each
// Source added by its link, then the Tiles not added yet.
export function TileShelf({
  apiConfig,
  sources,
  mirrors,
  removal,
  onSourceAdded,
  disabled,
}: {
  apiConfig: ApiConfig;
  sources: OverviewSource[];
  mirrors: OverviewMirror[];
  removal: SourceRemoval;
  onSourceAdded: () => void;
  disabled: boolean;
}): JSX.Element {
  const addTile = useAddTile(apiConfig, onSourceAdded);
  const tilesQuery = useTiles(apiConfig);
  const tiles = tilesQuery.data ?? [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const mirrorBySource = new Map(mirrors.map((mirror) => [mirror.sourceId, mirror]));
  const tileSourceIds = new Set(tiles.flatMap((tile) => tile.sourceId ?? []));
  // Until the Tiles load, a Tile's Source would show as added by link.
  const linked = tilesQuery.isLoading
    ? []
    : sources.filter((source) => !tileSourceIds.has(source.id));
  const added = (source: OverviewSource | undefined): AddedSource | null =>
    source ? { source, mirror: mirrorBySource.get(source.id), removal, disabled } : null;
  const tileCard = (tile: TileSummary) => (
    <SourceCard
      key={tile.id}
      testIds={{ card: `tile-${tile.id}`, facts: "tile", id: tile.id }}
      label={tile.label}
      url={tile.url}
      description={tile.description}
      recipe={tile.recipe}
      added={added(tile.sourceId === null ? undefined : sourceById.get(tile.sourceId))}
      add={
        tile.sourceId === null && (
          <button
            type="button"
            className="button ghost tile-add"
            onClick={() => addTile.mutate(tile.id)}
            disabled={disabled || addTile.isPending}
            aria-label={`Add ${tile.label}`}
            data-testid={`tile-add-${tile.id}`}
          >
            {addTile.isPending && addTile.variables === tile.id ? "Adding…" : "Add"}
          </button>
        )
      }
    />
  );
  return (
    <section className="tile-shelf" data-testid="tile-shelf" aria-labelledby="tile-shelf-title">
      <div className="tile-shelf-head">
        <h2 className="tile-shelf-title" id="tile-shelf-title">
          Sources
        </h2>
        <span className="tile-shelf-meta">
          Curated Tiles, and any Source you add by its link. Adding one syncs it.
        </span>
      </div>
      {tilesQuery.isLoading && <span className="tile-shelf-note">Loading Tiles…</span>}
      {tilesQuery.isError && (
        <span className="tile-shelf-note" data-testid="tile-shelf-error">
          Tiles are unavailable.
        </span>
      )}
      {(tiles.length > 0 || linked.length > 0) && (
        <ul className="tile-grid">
          {tiles.filter((tile) => tile.sourceId !== null).map(tileCard)}
          {linked.map((source) => (
            <SourceCard
              key={source.id}
              testIds={{ card: `kit-source-${source.id}`, facts: "kit-source", id: source.id }}
              label={source.label}
              url={null}
              description={
                source.kind === "local"
                  ? "Added from a folder on the Daemon machine."
                  : "Added from its repository link."
              }
              recipe={source.recipe}
              added={added(source)}
              add={null}
            />
          ))}
          {tiles.filter((tile) => tile.sourceId === null).map(tileCard)}
        </ul>
      )}
      <AddSourceStatus state={addTile} />
      <AddSourceForm apiConfig={apiConfig} onChanged={onSourceAdded} disabled={disabled} />
    </section>
  );
}

// An added Source and what removing it needs.
type AddedSource = {
  source: OverviewSource;
  mirror: OverviewMirror | undefined;
  removal: SourceRemoval;
  disabled: boolean;
};

// Remove shows on hover or keyboard focus, and asks once before it acts.
function SourceCard({
  testIds,
  label,
  url,
  description,
  recipe,
  added,
  add,
}: {
  // The facts read `${facts}-added-${id}`, `${facts}-recipe-${id}`, and `${facts}-whole-${id}`.
  testIds: { card: string; facts: string; id: string };
  label: string;
  url: string | null;
  description: string;
  recipe: Recipe | null;
  added: AddedSource | null;
  add: ReactNode;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const failed = added !== null && added.removal.failedId === added.source.id;
  useEffect(() => {
    if (failed) setConfirming(false);
  }, [failed]);
  const problem = added && sourceProblem(added.source, added.mirror);
  return (
    <li className={`tile-card ${added ? "tile-card-added" : ""}`} data-testid={testIds.card}>
      <div className="tile-card-head">
        {url ? (
          <a
            className="tile-card-label"
            href={url}
            onClick={(event) => {
              event.preventDefault();
              void openUrl(url);
            }}
            data-testid={`${testIds.facts}-link-${testIds.id}`}
          >
            {label}
          </a>
        ) : (
          <span className="tile-card-label">{label}</span>
        )}
        {added ? (
          <span className="tile-card-actions">
            {!confirming && (
              <button
                type="button"
                className="tile-remove"
                onClick={() => setConfirming(true)}
                disabled={added.disabled}
                aria-label={`Remove ${added.source.label}`}
                data-testid={`kit-source-delete-${added.source.id}`}
              >
                Remove
              </button>
            )}
            <span
              className="tile-added"
              title={readyTitle(added.mirror)}
              data-testid={`${testIds.facts}-added-${testIds.id}`}
            >
              Added
            </span>
          </span>
        ) : (
          add
        )}
      </div>
      <p className="tile-card-desc">{description}</p>
      {(recipe || problem) && (
        <div className="tile-card-badges">
          {recipe && (
            <span
              className="badge badge-source"
              data-testid={`${testIds.facts}-recipe-${testIds.id}`}
            >
              {recipe.label}
            </span>
          )}
          {recipe?.unit === "whole" && (
            <span
              className="badge badge-whole"
              data-testid={`${testIds.facts}-whole-${testIds.id}`}
            >
              Installs whole
            </span>
          )}
          {added && problem && (
            <span
              className={`kit-fresh ${problem === "Unavailable" ? "kit-fresh-error" : "kit-fresh-off"}`}
              data-testid={`kit-freshness-${added.source.id}`}
            >
              {problem}
            </span>
          )}
        </div>
      )}
      {added && confirming && <RemoveConfirm added={added} onCancel={() => setConfirming(false)} />}
    </li>
  );
}

// A healthy added Source needs no status line: the Added badge carries it.
function sourceProblem(
  source: OverviewSource,
  mirror: OverviewMirror | undefined,
): "Off" | "Unavailable" | null {
  if (!source.active) return "Off";
  return mirror?.error ? "Unavailable" : null;
}

function readyTitle(mirror: OverviewMirror | undefined): string | undefined {
  if (!mirror || mirror.error) return undefined;
  return mirror.identity ? `Ready · ${mirror.identity.slice(0, 7)}` : "Ready";
}

function RemoveConfirm({
  added,
  onCancel,
}: {
  added: AddedSource;
  onCancel: () => void;
}): JSX.Element {
  const { source, removal, disabled } = added;
  const pending = removal.pendingId === source.id;
  const turnsOff = removal.turnsOff(source.id);
  return (
    <div className="tile-remove-confirm" data-testid={`kit-source-delete-arm-${source.id}`}>
      <span className="tile-remove-prompt">
        Remove {source.label}?
        {turnsOff > 0 &&
          ` Its ${turnsOff} selected ${turnsOff === 1 ? "Capability turns" : "Capabilities turn"} off, and your next Deploy uninstalls ${turnsOff === 1 ? "it" : "them"}.`}
      </span>
      <span className="tile-remove-actions">
        <button
          type="button"
          className="tile-remove-go"
          onClick={() => removal.remove(source)}
          disabled={pending || disabled}
          data-testid={`kit-source-delete-confirm-${source.id}`}
        >
          {pending ? "Removing…" : "Remove"}
        </button>
        <button
          type="button"
          className="tile-remove-cancel"
          onClick={onCancel}
          disabled={pending}
          data-testid={`kit-source-delete-cancel-${source.id}`}
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

function AddSourceForm({
  apiConfig,
  onChanged,
  disabled,
}: {
  apiConfig: ApiConfig;
  onChanged: () => void;
  disabled: boolean;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const addSource = useMutation<AddSourceResult, AddSourceError, string>({
    mutationFn: (origin) => api.addSource(apiConfig, origin),
    onSuccess: onChanged,
    onError: (error) => {
      if (error.cause.kind === "malformed-success") onChanged();
    },
  });
  return (
    <div className="tile-shelf-link">
      <form
        className="add-source-form"
        data-testid="add-source-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const origin = inputRef.current?.value.trim() ?? "";
          if (!origin) return;
          addSource.mutate(origin, {
            onSuccess: () => {
              if (inputRef.current) inputRef.current.value = "";
              setEmpty(true);
            },
          });
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder="Add by link: a repository URL or absolute Daemon path"
          disabled={addSource.isPending || disabled}
          onInput={(event) => {
            setEmpty(event.currentTarget.value.trim().length === 0);
            if (!addSource.isPending && (addSource.isError || addSource.data)) addSource.reset();
          }}
          aria-label="Repository URL, GitHub folder URL, or absolute Daemon path of a Source to add"
          data-testid="add-source-input"
        />
        <button
          type="submit"
          className="button"
          disabled={addSource.isPending || empty || disabled}
          data-testid="add-source-submit"
        >
          {addSource.isPending ? "Adding…" : "Add Source"}
        </button>
      </form>
      <AddSourceStatus state={addSource} />
    </div>
  );
}
