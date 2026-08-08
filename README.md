# Sliver GUI

Sliver GUI is a cross-platform Electron operator console for Sliver. This first
feature slice covers implant generation, archived builds and profiles, and
job/listener management against a real Sliver server.

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
- Live connection state, recent server events, event-driven snapshot refresh,
  reconnect/backoff, and periodic reconciliation.
- Start and stop mTLS, WireGuard, DNS, HTTP, HTTPS, and TCP staging listeners.
- Generate session and beacon implants with target, format, C2, timing,
  hardening, limits, WireGuard, canary, HTTP profile, and shellcode options.
- Native save dialogs for generated and archived artifacts.
- Create, overwrite, list, and delete implant profiles; list, stage, download,
  and delete archived builds.
- Compression and AES/RC4 processing for TCP staging payloads.
- Accessible confirmation dialogs for destructive actions and local Font
  Awesome SVG icons.

Terminal-backed features such as interactive shell are intentionally outside
this first slice. They will use Ghostty Web when that slice is implemented.

## Development

The workspace expects the adjacent checkouts already present here:

- `./sliver/` — upstream backend, used as the protobuf and real-server source.
- `./sliver-script/` — TypeScript gRPC client consumed by Electron main.

The GUI does not import or modify upstream `./sliver/` source. The current
`sliver-script` checkout contains the GUI-facing API and regenerated protobuf
definitions, so a clean distribution of this repository must pin or include
that checkout before it is independently reproducible.

All tracked first-party JavaScript and JSX application, test, and tool-config
source has been converted to strict TypeScript. HTML, CSS, JSON, and packaging
metadata remain in their native formats. The adjacent `sliver` and
`sliver-script` checkouts, dependencies, and generated `dist` and `release`
outputs are ignored repository boundaries and are not part of the GUI's
TypeScript source project.

Requirements: Node.js 24 or newer and npm.

```sh
npm install
npm run dev
```

Useful checks:

```sh
npm run typecheck
npm test
npm run build
npm run package
```

`npm run package` creates an unpacked application for the current platform in
`release/`. `npm run dist` creates the configured macOS, Windows, or Linux
installers.

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
