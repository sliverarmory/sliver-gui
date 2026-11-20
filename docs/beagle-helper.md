# Persistent Beagle helper

AD Explorer keeps its existing renderer/preload IPC contract. Electron main owns
the executable, native file dialogs and project databases. Main starts the bundled
Beagle executable, or an explicitly configured override, with `helper-stdio` as
its only argument and `shell: false`.
Database paths, Cypher and parameter values travel as typed JSON over the private
stdin pipe. Stdout carries responses; stderr is drained without exposing backend
diagnostics or private query contents to the renderer.

## Executable trust

The default executable is bundled at build time. `protocol/beagle-provenance.json`
pins the Beagle source revision and release archive digests. Native preparation
verifies the downloads and their provenance, then stages the executable and
license material in `native/beagle/bin/`. macOS packaging combines the verified
Intel and Apple Silicon executables into a universal helper. Windows uses Beagle's
GNU x64 target; Linux uses its GNU x64 target built on Ubuntu 22.04.

The executable and its build record ship outside ASAR in `resources/beagle/`.
A second copy of the expected build record remains inside ASAR at
`native/beagle/packaged-provenance.json`, alongside the source manifest.
Preparation, pre-signing, and packaged-content checks verify these records and
the executable. Main checks the bundled identity before execution; on macOS and
Windows, signing changes must be authenticated against the application's signer.
The installed application never downloads Beagle.

Selecting a binary in the native file dialog grants initial trust to that file.
Main hashes it before executing it, stores the canonical path and SHA-256 in its
private version-2 project configuration, and verifies the pin before every launch.
Version-1 configurations retain their projects but require executable reselection.
Replacing or upgrading the binary requires another explicit selection.

An environment configuration requires both an absolute `SLIVER_BEAGLE_BINARY` and
`SLIVER_BEAGLE_SHA256`. Obtain the expected digest from a trusted build or release.
Explicit overrides must verify successfully; a broken override is not silently
replaced with the bundled helper. There is no PATH search. Final symlinks,
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
request is never replayed. Recoverable writes execute against a private staged database;
only a validated response followed by closed SQLite handles permits atomic publication.
Cancellation preserves the previous committed graph. The optional `closeDatabase` command
lets staged writes release and reopen databases inside the same persistent helper.
New file-export, backup, retention, rules and relay operations are advertised separately
from the original protocol-1 required set. See [P2 contracts and verification](beagle-p2-roadmap.md).

## Verification

Run `npm run typecheck` and the colocated Beagle Vitest suites for framing,
timeouts, crash/restart behavior, executable tampering, filtered environments,
configuration migration and serialized service behavior. Run
`SLIVER_BEAGLE_E2E_BINARY=/absolute/path/to/beagle npm run test:beagle:helper` for
the real Rust/TypeScript boundary using temporary synthetic collections. It checks
catalog retrieval, bound values, imports, queries, saved queries, tagging, analysis,
composition, export, project isolation, process reuse and restart persistence.
It requires no server or private collection. `npm run test:beagle:build` covers
release staging and packaging boundaries. After `npm run build:beagle`, run
`npm run test:beagle:loader` to exercise the real native helper and its ASAR trust
anchor through Electron. The package CI matrix runs both this probe and the
synthetic helper integration scenario. `npm run test:e2e:beagle:bundled` additionally
opens AD Explorer with fresh settings and no custom runtime environment, verifies
that runtime setup is unnecessary, and executes a parameterized query through
the UI. Its screenshot is saved as `artifacts/e2e/beagle-bundled.png`. Set
`SLIVER_BEAGLE_E2E_APP` to a packaged application executable to run the same smoke
against the production ASAR using isolated temporary home and user-data directories;
that screenshot is saved as `artifacts/e2e/beagle-bundled-packaged.png`.
The optional Electron GOAD test
remains separately configured through `npm run test:e2e:beagle`.

IronRDP's runtime and transport are unchanged.
