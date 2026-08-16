# External Daemon connections and matched releases

status: accepted
extends: ADR-0029
supersedes-in-part: ADR-0002 (Shell-owned Daemon lifecycle)

## What this ADR records

The Shell has two exclusive launch modes. Managed mode retains ADR-0002's local
probe-and-spawn lifecycle. External mode connects to one already-running Daemon
through a generic authenticated loopback endpoint and never probes, starts,
drains, stops, or falls back to a local Daemon.

The generic Hive seam contains no Arca command, host, tunnel, installation, or
service-manager assumption. Environment-specific adapters own transport and
Daemon installation outside this repository.

## External connection trust boundary

An external launcher passes only the path of an owner-only, one-shot connection
descriptor. The descriptor contains:

- a credential-free loopback HTTP origin;
- an expiring session id and token;
- the expected protocol range, build version, Daemon instance id, and opaque
  runtime-root id; and
- non-secret display metadata.

The Shell validates permissions and shape, reads the descriptor once, removes it,
and retains the credential in Electron main. Preload exposes sender-bound relative
API requests; it never exposes the token to the renderer main world or places it
in a URL, argument, persistent setting, or log.

The Daemon's durable token can mint and revoke external sessions only from the
loopback API. Sessions are memory-only, store a token hash, have a bounded maximum
lifetime, and cannot mint other sessions. Restart, expiry, or explicit revocation
invalidates them; the durable token never leaves the Daemon machine.

Before opening the window, the Shell requires exact protocol, build, instance,
runtime-root, packaged-mode, and real-deployment-target compatibility. A mismatch
is terminal for that launch. External Shell exit leaves the Daemon and accepted
Deploy operations running.

## Matched release channel

One verified source commit produces exactly three supported artifacts:

- native macOS arm64 Shell;
- native macOS x64 Shell; and
- standalone Linux x64 Daemon.

Every artifact reports the same embedded build version and protocol contract. A
strict stable manifest names the full source commit, build version, exact artifact
matrix, public credential-free URLs, byte sizes, and SHA-256 digests.

Only a successful `verify` workflow for a push to `main` may publish. Publication
creates or repairs an immutable commit-named GitHub release, rejects unexpected or
different existing assets, and downloads every published asset for byte comparison
before advancing the channel. A partial upload is safely retryable. The
`release-channel` branch advances only while `main` still names the verified
commit and the manifest passes the same strict schema with that exact commit.

Source content updates remain independent of executable releases: Source Locators
can refresh Mirrors without replacing the Shell or Daemon.

## Consequences

- A Shell cannot silently connect to a different runtime or downgrade into local
  managed mode.
- The external session is disposable; the long-lived Daemon is intentionally
  cheap to keep and remains adapter-owned.
- Public release artifacts require no credential on the Mac, while Source and
  deployment credentials remain on the Daemon machine.
- Release workflow availability is required to produce supported native artifacts;
  user machines do not build from an unpinned branch during daily launch.
- A compromised or malformed stable manifest is rejected before release upload or
  channel advancement.

## Out of scope

The transport implementation, tunnel supervision, system service ownership,
machine-specific paths, code signing, and automatic Daemon upgrades belong to the
environment adapter or later distribution work.
