# Sliver GUI

Sliver GUI is a cross-platform Electron operator console for Sliver. Its current
operator slices cover implant generation, archived builds and profiles,
job/listener management, and authoritative session, beacon, and task workflows
against a real Sliver server.

The renderer is built with HeroUI and HeroUI Pro, uses the Font Awesome Free
icon set, and has no direct Node.js, filesystem, or network access. Sliver
configuration files and their private keys stay in the Electron main process.

## Implemented features

- Multiple application windows, each connected to the same or a different
  backend. Windows using the same operator configuration share one ref-counted
  backend connection; unrelated configurations remain isolated.
- Automatic discovery of operator configurations in
  `~/.sliver-client/configs`, with a metadata-rich selector and the native file
  picker retained for configs stored elsewhere. Config secrets and full paths
  remain in Electron main.
- Optional config import creates a private GUI-managed copy with a local display
  name. Deleting is available only for that managed copy; forgetting a
  pre-existing or externally selected config never deletes its source file.
- Packaged operator connections use mTLS for M0. WireGuard operator configs are
  still listed with an explicit deferred state and cannot connect, while
  WireGuard implant C2 and listener workflows remain independent features.
- Live connection state, recent server events, event-driven snapshot refresh,
  reconnect/backoff, and periodic reconciliation.
- Dedicated, bounded, searchable Sessions and Beacons dashboards with
  authoritative target state, capability state, read-only operator presence,
  and an active target that remains local to each application window. Opening a
  live session navigates to its dedicated interaction workbench instead of
  expanding an inline selected-session card.
- A session-first M2 workbench with clean Overview, Files, Processes,
  Environment, Windows Registry, and Activity panels. Files includes bounded
  browser, content-search, and storage modes; Cat, Head, Tail, and Hex views;
  digest-bound reviewed text/hex saves; native single-file transfers; reviewed
  copy/move/remove; metadata controls; mount inventory; and Linux memory files.
- Processes includes bounded continuation, list/tree presentation, filters,
  platform-gated dumps and termination, plus Windows service workflows. The
  Windows Registry panel supports bounded browsing and hive save plus reviewed
  typed write, create-key, and delete-key mutations.
- Activity unifies M1 and session-workbench history for the exact session while
  excluding command content, secrets, binary data, and local paths.
- Session workbench mutations are a closed typed allowlist. Destructive or
  replacement actions use expiring one-use review plans, target and platform
  restrictions are revalidated in Electron main, and local paths and binary
  buffers never cross into the renderer.
- Target selection and backgrounding, beacon watch, rename, kill/close/remove,
  bounded dead-state pruning, typed timing reconfiguration, and beacon-to-session
  conversion over the main-owned current C2 endpoint.
- A closed typed operation engine for synchronous session and asynchronous
  beacon ping and environment mutations, with request ownership, progress,
  timeout and outcome reconciliation, and no renderer-selectable RPC methods.
- Bounded beacon task history, detail and typed result decoding, locally
  correlated ownership, best-effort cancellation, and reconnect reconciliation.
- Start and stop mTLS, WireGuard, DNS, HTTP, HTTPS, and TCP staging listeners.
- Generate session and beacon implants with target, format, C2, timing,
  hardening, limits, WireGuard, canary, HTTP profile, and shellcode options.
- Native save dialogs for generated and archived artifacts.
- Create, overwrite, list, and delete implant profiles; list, stage, download,
  and delete archived builds.
- Compression and AES/RC4 processing for TCP staging payloads.
- Accessible confirmation dialogs for destructive actions and local Font
  Awesome SVG icons.

The operator accepted the session-first M2 scope on 2026-08-10 and unlocked M3.
M3 is now implementing bounded streaming and managed interactive shells with
packaged Ghostty Web. Deferred M2 work remains visible in the roadmap: supported
beacon execution, complete cross-platform real-server evidence, the central
authoritative capability service, mutation-stable anchor cursors, and remote
loot dispositions. Current workbench continuation tokens are bounded offsets,
so a changing remote inventory can still duplicate or skip entries between
pages.

## Development

The TypeScript gRPC client used by Electron main is tracked as a minimal source
snapshot in `vendor/sliver-script`. This keeps clean checkouts reproducible
without pulling the full upstream Sliver tree. Its provenance and update notes
are recorded in `vendor/sliver-script/VENDORED.md`.

Sliver GUI is licensed under GPL-3.0-or-later. Native packages include the
license, third-party notice, retained client source, and its verifiable Git
provenance bundle; matching release tags provide the complete GUI source.

An adjacent `./sliver/` checkout is optional for backend development and is
ignored by this repository. The GUI does not import or modify that checkout.

All tracked first-party JavaScript and JSX application, test, and tool-config
source has been converted to strict TypeScript. HTML, CSS, JSON, and packaging
metadata remain in their native formats. Dependencies and generated `dist`,
`release`, and vendored-client `lib` outputs are ignored and are not part of
the GUI's TypeScript source project.

Requirements: Node.js 24 or newer, npm 11.19 or newer, and a HeroUI Pro
license. Set `HEROUI_AUTH_TOKEN` for automated installs, or authenticate with
the HeroUI Pro CLI and install its artifacts before building locally.

```sh
npm ci --strict-allow-scripts
npx heroui-pro login
npx heroui-pro install --yes
npm run dev
```

The HeroUI login/install steps are only needed once per workstation and can be
skipped when `HEROUI_AUTH_TOKEN` is already present in the environment.

Useful checks:

```sh
npm run typecheck
npm test
npm run protocol:check
npm run test:e2e:electron
npm run test:e2e:m1
npm run build
npm run package
npm run test:e2e:packaged
npm run test:m0
```

`npm run protocol:check` is authoritative under the locked CI toolchain: Node
24.0.0, npm 11.19.0, Go 1.25.8, and protoc 35.1. `npm run test:m0` retains the
M0 current-platform regression gate. `npm run test:e2e:electron` exercises the
M1 target/task path and the dedicated session-first M2 workbench through the
production renderer, frozen preload, trusted IPC, and an injected Sliver
client; `npm run test:e2e:m1` remains an alias for that current-slice lane.
Opt-in actual-server package tests remain separate because they require an
authorized disposable server and operator configuration.

`npm run package` creates an unpacked application for the current platform in
`release/`. `npm run dist` creates the configured macOS, Windows, or Linux
installers.

## Continuous integration and releases

GitHub Actions verifies the locked Sliver protocol/parity baseline, runs the
real Electron current-slice E2E, and creates native packages on pull requests
and every push to `main`: a universal macOS DMG/ZIP, x64 Windows
installer/portable executables, and x64 Linux AppImage/DEB packages. Each
unpacked native application is exercised against a loopback mutual-TLS fixture
before the packages are retained as workflow artifacts for 14 days on pull
requests and 30 days on `main`, tag, and manually dispatched builds.

The hosted jobs use versioned build images, but they exercise unpacked output
and do not claim the minimum-runtime installed-package certification recorded
as pending in the platform-support ADR. Dedicated Ventura 13.7.8 arm64/Intel,
Windows 11 24H2, and Ubuntu 22.04.5 install lanes remain required before that
certification evidence can be marked complete.

The repository or organization must provide an Actions secret named
`HEROUI_AUTH_TOKEN`. Create a CI/CD token in the HeroUI Pro dashboard and add it
before enabling the workflow; the build fails early with a direct error when
the secret is unavailable.

Pushing a stable version tag such as `v1.2.3` runs the same clean native builds,
sets the packaged application version to `1.2.3`, and creates a draft GitHub
release containing all six packages plus `SHA256SUMS`. Release binaries are
currently unsigned, so automation never publishes that draft. Signing,
notarization, and their verification evidence are required before a maintainer
publishes a stable release.

## Real-server integration test

Start a disposable server, create an operator configuration, and opt in with:

```sh
SLIVER_GUI_E2E_CONFIG=/absolute/path/operator.cfg \
SLIVER_GUI_E2E_LISTENER_PORT=18888 \
npm test -- --run src/e2e/real-server.test.ts
```

The test connects over mTLS, starts and stops a listener while observing server
events, generates a real implant, checks the archived build, and exercises
staging and profile lifecycle cleanup. It is skipped during normal unit runs.

After building the unpacked native application with `npm run package`, exercise
that production executable through its real renderer, frozen preload, trusted
IPC handlers, and connection registry against the same disposable server:

```sh
SLIVER_GUI_E2E_CONFIG=/absolute/path/operator.cfg \
SLIVER_GUI_E2E_LISTENER_PORT=18888 \
npm run test:e2e:packaged-real
```

Use a currently unused listener port. The packaged-app test copies the mTLS
configuration into an isolated `0600` home directory, starts one loopback mTLS
listener, reviews the production stop impact, stops only the job it created,
disconnects, and performs fallback cleanup if the UI path is interrupted.

To exercise M1 through the freshly packaged production application, opt in
against an authorized disposable loopback server with an unused port from 1 to
65534:

```sh
SLIVER_GUI_M1_REAL_E2E=1 \
SLIVER_GUI_E2E_CONFIG=/absolute/path/operator.cfg \
SLIVER_GUI_E2E_LISTENER_PORT=18889 \
npm run test:e2e:packaged-real-m1
```

The M1 harness creates and runs one test-owned session implant and one
test-owned beacon implant against an exact loopback HTTPS listener. It verifies
synchronous and asynchronous operations, typed beacon-task decoding,
reconfiguration, current-C2 session conversion, and authoritative task
cancellation. Cleanup is restricted to captured test-owned process, target,
listener, profile, and build identities; no wildcard or server-wide clean is
used.

## Security boundary

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`, and webviews disabled.
- The main window installs a response-header Content Security Policy. Script
  directives allow only local bundled JavaScript and explicitly forbid inline
  scripts, eval-like execution, inline event handlers, workers, remote
  connections, objects, and frames.
- Navigation, new windows, permissions, and device access are denied. IPC
  accepts only the exact trusted renderer URL, its main frame, and its owning
  BrowserWindow.
- The preload exposes a frozen, typed set of narrowly scoped operations. Raw
  gRPC clients, tokens, certificates, keys, and arbitrary filesystem access are
  never exposed to renderer code.
- Server events are invalidation hints rather than authoritative state. The GUI
  refetches snapshots after relevant events, mutations, and reconnects because
  the upstream event broker can drop events under pressure.

## Current upstream limitations

- Runtime TCP staging works, but upstream Sliver does not completely persist
  and restore TCP staging-listener configuration across server restarts.
- The console's `RestartJobs` behavior is not exposed because the backend RPC
  does not safely represent a single listener restart. Stop and explicit start
  are supported.
- Ghostty Web is not loaded in this slice, so the strict CSP does not yet need a
  WebAssembly or worker exception.
