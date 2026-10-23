# Persistent Beagle helper

AD Explorer keeps its existing renderer/preload IPC contract. Electron main owns
the executable, native file dialogs and project databases. Main starts an external
Beagle executable with `helper-stdio` as its only argument and `shell: false`.
Database paths, Cypher and parameter values travel as typed JSON over the private
stdin pipe. Stdout carries responses; stderr is drained without exposing backend
diagnostics or private query contents to the renderer.

## Executable trust

Selecting a binary in the native file dialog grants initial trust to that file.
Main hashes it before executing it, stores the canonical path and SHA-256 in its
private version-2 project configuration, and verifies the pin before every launch.
Version-1 configurations retain their projects but require executable reselection.
Replacing or upgrading the binary requires another explicit selection.

An environment configuration requires both an absolute `SLIVER_BEAGLE_BINARY` and
`SLIVER_BEAGLE_SHA256`. Obtain the expected digest from a trusted build or release.
There is no PATH search or automatic bundled-file fallback. Final symlinks,
nonregular files, empty or oversized files, and POSIX files with world-write or
setuid/setgid bits are rejected. Hashing checks file identity and metadata before,
during and after reading. This pins the selected bytes; it does not establish
publisher identity or sandbox the helper. As with other local executable checks,
it does not defend against a process with the same account's access racing a file
replacement between verification and OS execution.

The child receives an explicit allowlist of home/profile directories, OS directories,
temporary directories and locale/timezone variables. PATH, application credentials,
Node settings, dynamic-loader overrides and GraphQLite extension overrides are
excluded. The main-only `beagle-runtime-loader.ts` contains the exact allowlist.

## Protocol and lifecycle

Protocol 1 uses newline-delimited UTF-8 JSON. A readiness frame identifies Beagle,
its version, supported operations and wire limits. Main requires all expected
operations and opens a temporary in-memory database to check query capabilities
before opening any project database. The probe exits after validation.

Each request has a strictly increasing integer `id` and a discriminated `command`.
Each response echoes the ID and contains either `value` or a structured `error`.
Commands cover open, stats, query, savedQuery, catalog, savedQueryInfo, entity,
ingest, analyze, tag, compose, export, paths and shutdown. The catalog carries
all 177 authoritative parameterized query templates in one request. The existing
Beagle CLI and legacy `serve-stdio` command remain available for other callers.

The client permits one request at a time. Requests are bounded to 1 MiB and
responses to 32 MiB, including the final newline. Malformed frames, unexpected IDs,
incompatible readiness or broken pipes retire the helper. A normal operation error
leaves it available for the next request. The renderer's read-only Cypher and
native-file-selection restrictions still apply.

One helper owns one selected project database. A project switch closes stdin and
waits for the old process to exit before starting its replacement. Shutdown also
waits for exit, with a force-kill fallback. Deadlines or cancellation kill the
helper. A later explicit request can launch a newly verified helper, but the failed
request is never replayed: interrupted writes may have committed before the pipe
closed. Imports and analysis retain an uncertain-diagnostics marker until their
verified response is received.

## Verification

Run `npm run typecheck` and the colocated Beagle Vitest suites for framing,
timeouts, crash/restart behavior, executable tampering, filtered environments,
configuration migration and serialized service behavior. Run
`SLIVER_BEAGLE_E2E_BINARY=/absolute/path/to/beagle npm run test:beagle:helper` for
the real Rust/TypeScript boundary using temporary synthetic collections. It checks
catalog retrieval, bound values, imports, queries, saved queries, tagging, analysis,
composition, export, project isolation, process reuse and restart persistence.
It requires no server or private collection. The optional Electron GOAD test
remains separately configured through `npm run test:e2e:beagle`.

IronRDP's runtime and transport are unchanged.
