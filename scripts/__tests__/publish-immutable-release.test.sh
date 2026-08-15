#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAM="$REPO_ROOT/scripts/publish-immutable-release.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hive-immutable-release-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

COMMIT='0123456789abcdef0123456789abcdef01234567'
ASSETS="$TEST_ROOT/assets"
EXISTING="$TEST_ROOT/existing"
BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/gh.log"
mkdir -p "$ASSETS" "$EXISTING" "$BIN"

for name in Hive-darwin-arm64.tar.gz Hive-darwin-x64.tar.gz hive-daemon-linux-x64; do
  printf 'verified-%s\n' "$name" >"$ASSETS/$name"
done
printf '{"schemaVersion":1,"channel":"stable"}\n' >"$TEST_ROOT/stable.json"
cp "$ASSETS"/* "$EXISTING/"
cp "$TEST_ROOT/stable.json" "$EXISTING/stable.json"

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" = 'release view' ]]; then
  [[ "${FAKE_RELEASE_MODE:-missing}" = existing ]] || exit 1
  printf '%s\n' '{"targetCommitish":"0123456789abcdef0123456789abcdef01234567","assets":[{"name":"Hive-darwin-arm64.tar.gz"},{"name":"Hive-darwin-x64.tar.gz"},{"name":"hive-daemon-linux-x64"},{"name":"stable.json"}]}'
  exit 0
fi
if [[ "$1 $2" = 'release download' ]]; then
  destination=''
  while (($#)); do
    if [[ "$1" = --dir ]]; then destination="$2"; break; fi
    shift
  done
  cp "$FAKE_EXISTING_DIR"/* "$destination/"
  exit 0
fi
if [[ "$1 $2" = 'release create' ]]; then
  printf '%s\n' "$*" >>"$FAKE_GH_LOG"
  exit 0
fi
exit 97
EOF
chmod 755 "$BIN/gh"

run_program() {
  PATH="$BIN:$PATH" \
    FAKE_RELEASE_MODE="$1" \
    FAKE_EXISTING_DIR="$EXISTING" \
    FAKE_GH_LOG="$LOG" \
    "$PROGRAM" \
      --source-commit "$COMMIT" \
      --assets "$ASSETS" \
      --manifest "$TEST_ROOT/stable.json"
}

run_program missing
grep -q '^release create ' "$LOG"

: >"$LOG"
run_program existing
[[ ! -s "$LOG" ]]

printf 'corrupt\n' >"$EXISTING/hive-daemon-linux-x64"
if run_program existing; then
  echo 'expected a mismatched existing release to fail' >&2
  exit 1
fi

printf '%s\n' 'PASS: immutable release publication is safe to retry'
