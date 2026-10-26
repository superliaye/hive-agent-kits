#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$TEST_PARENT"
TEST_ROOT="$(mktemp -d "$TEST_PARENT/hive-packaged-daemon-test.XXXXXX")"
DAEMON_PID=''

cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

binary="$TEST_ROOT/hive-daemon"
runtime="$TEST_ROOT/runtime"
home="$TEST_ROOT/home"
port="$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
mkdir -p "$runtime" "$home"

bun build --compile \
  --define 'process.env.HIVE_BUILD_VERSION="packaged-daemon-test"' \
  "$ROOT/packages/daemon/src/server/start.ts" \
  --outfile "$binary" >/dev/null

HOME="$home" HIVE_RUNTIME_ROOT="$runtime" HIVE_PACKAGED=1 HIVE_PORT="$port" \
  "$binary" >"$TEST_ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$runtime/.token" ]] || {
    sleep 0.1
    continue
  }
  token="$(cat "$runtime/.token")"
  state="$(curl -fsS -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$port/api/kit/state" 2>/dev/null || true)"
  [[ -n "$state" ]] && break
  sleep 0.1
done

[[ -n "${state:-}" ]] || {
  printf 'packaged Daemon did not answer /api/kit/state\n' >&2
  sed -n '1,160p' "$TEST_ROOT/daemon.log" >&2
  exit 1
}
# A fresh install starts with no Sources; the Tiles ship inside the binary.
jq -e '.sync == []' <<<"$state" >/dev/null || {
  printf 'packaged Daemon seeded Sources on first launch: %s\n' "$state" >&2
  exit 1
}
tiles="$(curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$port/api/tiles")"
jq -e 'length > 0 and all(.[]; .sourceId == null) and (map(.id) | index("my-agent-kits") != null)' \
  <<<"$tiles" >/dev/null
printf 'PASS: packaged Daemon boots with no Sources and serves the Tiles\n'
