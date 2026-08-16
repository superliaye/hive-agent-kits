#!/usr/bin/env bash
set -euo pipefail
umask 077

PROGRAM="${0##*/}"
SOURCE_COMMIT=''
ASSETS=''
MANIFEST=''
ASSET_BASE_URL=''
WORK_DIR=''

die() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

cleanup() {
  local status="${1:-$?}"
  trap - EXIT HUP INT TERM
  [[ -z "$WORK_DIR" || ! -d "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  exit "$status"
}

trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

usage() {
  printf 'usage: %s --source-commit <commit> --assets <directory> --manifest <stable.json> --asset-base-url <url>\n' \
    "$PROGRAM" >&2
  exit 2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source-commit)
      [[ "$#" -ge 2 && -z "$SOURCE_COMMIT" ]] || usage
      SOURCE_COMMIT="$2"
      shift 2
      ;;
    --assets)
      [[ "$#" -ge 2 && -z "$ASSETS" ]] || usage
      ASSETS="$2"
      shift 2
      ;;
    --manifest)
      [[ "$#" -ge 2 && -z "$MANIFEST" ]] || usage
      MANIFEST="$2"
      shift 2
      ;;
    --asset-base-url)
      [[ "$#" -ge 2 && -z "$ASSET_BASE_URL" ]] || usage
      ASSET_BASE_URL="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'source commit must be a full commit ID'
[[ -d "$ASSETS" ]] || die 'assets directory is unavailable'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || die 'manifest must be a regular file'
[[ -n "$ASSET_BASE_URL" ]] || usage
bun run "${BASH_SOURCE[0]%/*}/validate-release-manifest.ts" \
  "$MANIFEST" "$SOURCE_COMMIT" "$ASSETS" "$ASSET_BASE_URL" >/dev/null

readonly TAG="hive-g$SOURCE_COMMIT"
readonly RELEASE_FILES=(
  Hive-darwin-arm64.tar.gz
  Hive-darwin-x64.tar.gz
  hive-daemon-linux-x64
  stable.json
)
for name in "${RELEASE_FILES[@]:0:3}"; do
  [[ -f "$ASSETS/$name" && ! -L "$ASSETS/$name" ]] || die "release asset is unavailable: $name"
done

asset_path() {
  case "$1" in
    stable.json) printf '%s\n' "$MANIFEST" ;;
    *) printf '%s\n' "$ASSETS/$1" ;;
  esac
}

has_asset() {
  local wanted="$1"
  shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" != "$wanted" ]] || return 0
  done
  return 1
}

validate_release_identity() {
  local release_json="$1"
  local require_complete="$2"
  local target
  target="$(jq -er '.targetCommitish' <<<"$release_json")" ||
    die "existing release identity is unreadable: $TAG"
  [[ "$target" = "$SOURCE_COMMIT" ]] || die "existing release identity is incompatible: $TAG"
  jq -e '.isDraft == false and .isPrerelease == false' <<<"$release_json" >/dev/null ||
    die "existing release is not publicly downloadable: $TAG"

  jq -e '.assets | type == "array" and all(.[]; (.name | type) == "string")' \
    <<<"$release_json" >/dev/null || die "existing release asset metadata is unreadable: $TAG"
  local existing=()
  local name
  while IFS= read -r name; do
    existing+=("$name")
  done < <(jq -r '.assets[].name' <<<"$release_json")
  local seen=()
  for name in "${existing[@]}"; do
    has_asset "$name" "${RELEASE_FILES[@]}" || die "existing release has an unexpected asset: $name"
    ! has_asset "$name" "${seen[@]}" || die "existing release has a duplicate asset: $name"
    seen+=("$name")
  done
  if [[ "$require_complete" = 1 ]]; then
    [[ "${#seen[@]}" -eq "${#RELEASE_FILES[@]}" ]] ||
      die "release is incomplete after upload: $TAG"
    for name in "${RELEASE_FILES[@]}"; do
      has_asset "$name" "${seen[@]}" || die "release is missing asset after upload: $name"
    done
  fi
  VALIDATED_ASSETS=("${seen[@]}")
}

download_and_verify() {
  local max_attempts="$1"
  shift
  local names=("$@")
  [[ "${#names[@]}" -gt 0 ]] || return 0
  [[ -n "$WORK_DIR" ]] || WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-release-download.XXXXXX")"
  local attempt name valid
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    rm -rf -- "$WORK_DIR"
    mkdir -p -- "$WORK_DIR"
    valid=1
    if gh release download "$TAG" --dir "$WORK_DIR"; then
      for name in "${names[@]}"; do
        cmp -s "$(asset_path "$name")" "$WORK_DIR/$name" || valid=0
      done
      [[ "$valid" -ne 1 ]] || return 0
    fi
    [[ "$attempt" -eq "$max_attempts" ]] || sleep 2
  done
  die "published release assets could not be verified byte-for-byte: $TAG"
}

if ! release_json="$(gh release view "$TAG" --json targetCommitish,assets,isDraft,isPrerelease 2>/dev/null)"; then
  gh release create "$TAG" \
    --target "$SOURCE_COMMIT" \
    --title "Hive g${SOURCE_COMMIT:0:12}" \
    --notes "Verified matched Hive Shell and Daemon release from $SOURCE_COMMIT." \
    --latest=false
  release_json="$(gh release view "$TAG" --json targetCommitish,assets,isDraft,isPrerelease)"
fi

VALIDATED_ASSETS=()
validate_release_identity "$release_json" 0
existing_assets=("${VALIDATED_ASSETS[@]}")
download_and_verify 1 "${existing_assets[@]}"

missing_paths=()
for name in "${RELEASE_FILES[@]}"; do
  has_asset "$name" "${existing_assets[@]}" || missing_paths+=("$(asset_path "$name")")
done
if [[ "${#missing_paths[@]}" -gt 0 ]]; then
  gh release upload "$TAG" "${missing_paths[@]}"
fi

release_json="$(gh release view "$TAG" --json targetCommitish,assets,isDraft,isPrerelease)"
validate_release_identity "$release_json" 1 >/dev/null
download_and_verify 5 "${RELEASE_FILES[@]}"
