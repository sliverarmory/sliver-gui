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
- A session-only managed-shell workspace in the Shell tab. Operators can
  start, list, select-to-attach, detach, close, and kill shells; pop the exact
  managed inventory into a main-created dedicated window; use explicit copy
  and reviewed paste controls; and see lifecycle, pressure, and byte-count
  metadata without terminal content entering React state, snapshots, Activity,
  or logs.
- A dedicated full Sliver console window backed by the pinned native Go
  `sliver-client` and rendered with Ghostty Web. It opens directly against the
  active window's verified operator configuration while using the user's real
  `~/.sliver-client` root for installed aliases, extensions, Armory data,
  themes, and settings. Electron main stages the selected config and command
  history in a private temporary workspace, disables transcript logging, and
  owns the PTY, process, input/output bounds, and cleanup.
- A target execution workbench for bounded process, assembly, raw-shellcode,
  shared-library, reflective-DLL, migration, Metasploit, psexec, SSH, backdoor,
  DLL-hijack, token, identity, get-system, child-process, and privilege
  workflows. Electron main owns the closed capability catalog, native artifacts,
  one-use review plans, credentials, target revalidation, output retention, and
  asynchronous beacon-task correlation.
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

The operator accepted and completed the session-first M2 scope on 2026-08-10,
then accepted the delivered session-shell M3 scope and explicitly authorized M4
on 2026-08-15. The bounded M4 execution and privilege workbench is delivered and
**awaiting operator acceptance**; M5 has not started. Deferred M2 work remains
visible in the roadmap: supported beacon execution for the M2 reconnaissance
families, complete cross-platform real-server evidence, the central
authoritative capability service, mutation-stable anchor cursors, and remote
loot dispositions. Current workbench continuation tokens are bounded offsets,
so a changing remote inventory can still duplicate or skip entries between
pages.

M3 does not claim beacon-shell parity because the pinned upstream command tree
has no beacon shell workflow. It also does not claim forwarding, reverse
forwarding, or SOCKS; those remain M5. A detached shell can be reattached only
from the same live client and its exact owning workspace or main-mediated
dedicated shell window; generic windows cannot claim or act on it. PTY
allocation is requested but not confirmed by the upstream protocol, and resize
and remote closure are best-effort operations. See
[M3 verification](docs/m3-verification.md) for the exact boundary and deferred
evidence.

M4 does not claim complete command-option parity. Psexec, SSH, executable
backdoor, DLL hijack, and get-system are session-only. Supported beacon results
are accepted only after exact task, description, operation, and protobuf
verification, with bounded decoded output available for native save. The pinned
implant's empty `TaskReq` result cannot distinguish shellcode, Metasploit, or
Metasploit-inject success from failure, so those beacon outcomes remain unknown.
Synchronous session RPCs have no safe post-dispatch cancellation; interactive
and advanced-transform shellcode modes remain deferred; and real
Windows/Linux target-package evidence is still required. Review plans and
inputs are never replayed after transport uncertainty. See
[M4 verification](docs/m4-verification.md) for the delivered boundary and
operator checklist.

## Development

The TypeScript gRPC client used by Electron main is the exact npm dependency
`sliver-script@2.0.0-rc.2`. The lockfile pins its registry tarball integrity, and
`protocol/sliver-script-provenance.json` verifies the installed package and its
Sliver protobuf baseline without relying on an adjacent client checkout.

Sliver GUI is licensed under GPL-3.0-or-later and is not dual-licensed under
MIT or Apache-2.0. Separately identified third-party components retain their
own licenses; see [`LICENSES/LICENSING.md`](LICENSES/LICENSING.md),
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and [`LICENSES/`](LICENSES/).
Native packages include these notices, the published TypeScript client's source
and package/protobuf provenance locks. The native Go console's exact
upstream corresponding source is identified by
`protocol/sliver-console-provenance.json` and its packaged copy; matching
release tags provide the complete GUI source.

An adjacent `./sliver/` checkout is optional for ordinary renderer/backend
development and ignored by this repository. Native console and distribution
builds require that directory (or `SLIVER_SOURCE_DIR`) to be a clean checkout
at commit `ca685f5eed64c3327c0e57504928cfd2d2e96bea`; the build refuses a
different commit/tree or local source changes and does not fetch or modify the
checkout. Source and toolchain requirements are pinned in
`protocol/sliver-console-provenance.json`.

All tracked first-party JavaScript and JSX application, test, and tool-config
source has been converted to strict TypeScript. HTML, CSS, JSON, and packaging
metadata remain in their native formats. Dependencies and generated `dist` and
`release` outputs are ignored and are not part of the GUI's TypeScript source
project.

Requirements: Node.js 24 or newer, npm 11.19 or newer, and a HeroUI Pro
license. Native console/distribution builds additionally require Go 1.26.6;
universal macOS builds use the system `/usr/bin/lipo`. Set `HEROUI_AUTH_TOKEN`
for automated installs, or authenticate with the HeroUI Pro CLI and install its
artifacts before building locally.

The console build forces `GOTOOLCHAIN=local`, `GOENV=off`, `GOWORK=off`, and
an empty `GOFLAGS`; Go's automatic toolchain download/switching is deliberately
disabled for provenance. Put an actual Go 1.26.6 binary first on `PATH` or set
`SLIVER_GO_BINARY` to that binary's absolute path.

```sh
npm ci --strict-allow-scripts
npx heroui-pro login
npx heroui-pro install --yes
npm run dev
```

`npm run dev` builds and opens the same static renderer used by production.
This deliberately avoids Vite's inline React refresh bootstrap and HMR
WebSocket so the renderer can keep the production content security policy;
restart the command after source changes.

The HeroUI login/install steps are only needed once per workstation and can be
skipped when `HEROUI_AUTH_TOKEN` is already present in the environment.

Useful checks:

```sh
npm run typecheck
npm test
npm run protocol:check
npm run protocol:ghostty
npm run parity:check
npm run build:console
npm run test:e2e:electron
npm run test:e2e:m1
npm run build
npm run package
npm run test:e2e:packaged
npm run test:m0
```

`npm run protocol:check` is authoritative under the locked CI toolchain: Node
24.0.0, npm 11.19.0, Go 1.26.6, and protoc 35.1. `npm run test:m0` retains the
M0 current-platform regression gate. `npm run test:e2e:electron` exercises the
M1 target/task path, the dedicated session-first M2 workbench, and the
deterministic M3 managed-shell and M4 execution paths through the production
renderer, frozen preload, trusted IPC, and an injected Sliver client;
`npm run test:e2e:m1` remains an alias for that current-slice lane.
Opt-in actual-server package tests remain separate because they require an
authorized disposable server and operator configuration.

`npm run build:console` creates only ignored artifacts under
`native/sliver-console/`: the platform executable and a digest-bound build
record. The build applies the reviewed, hash-bound Go sources under
`protocol/sliver-console-overlay/`; packaged applications include those exact
replacement sources beside their provenance. On macOS the executable is
universal. `npm run package` creates an
unpacked application for the current platform in `release/`; `npm run dist`
creates the configured macOS, Windows, or Linux installers. Packaging verifies
the exact executable digest before signing, then verifies architecture,
embedded Go build/VCS metadata, and the nested publisher signature after a
signed release is assembled.

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
the secret is unavailable. Pull requests from public forks cannot receive this
licensed-package secret, so they run the non-secret protocol/parity job while
Electron E2E and native packaging remain skipped. A maintainer branch, `main`
push, or release tag must run the complete token-backed suite before release.

Packaged installations use `electron-updater@6.8.9` and the public GitHub
Releases feed for `sliverarmory/sliver-gui`; the application contains no GitHub
token. It checks after startup and periodically, downloads an available stable
update in the background, and installs the downloaded version when the
operator chooses **Restart to update** or exits the application normally. An
installed application never treats a draft or prerelease as a stable update.

The first updater-capable build is a one-time manual bootstrap: applications
installed before updater support exists cannot update themselves. Install that
release normally, and later releases can use the automatic path. Update support
by package is:

| Platform package | Automatic update path |
| --- | --- |
| macOS universal DMG/ZIP | Install from the DMG; the updater downloads the signed ZIP described by `latest-mac.yml`. |
| Windows x64 NSIS installer | Downloads the signed NSIS installer described by `latest.yml`. |
| Windows x64 portable executable | Manual update only; download a signed package from the [latest GitHub release](https://github.com/sliverarmory/sliver-gui/releases/latest) and verify `SHA256SUMS`, or install the Setup build for automatic updates. |
| Linux x64 AppImage | Downloads the AppImage described by `latest-linux.yml`. |
| Linux x64 Debian package | Manual update only; verify the package against the release `SHA256SUMS`, or use the AppImage build for automatic updates. |

### Manual private updater E2E

Before changing repository visibility, manually dispatch **Private GitHub
updater E2E**. It builds increasing prerelease versions from the same commit
with the isolated `electron-builder-updater-e2e.yml` private-feed profile. The
built-in job token is exposed only to individual GitHub CLI publication steps
and the native test process; it is never available to packaging or written into
an application, release asset, diagnostic bundle, or log.

The macOS and Windows build jobs each create one ephemeral self-signed test
identity and use it for both versions. This proves signature continuity and the
installed DMG-to-ZIP and NSIS paths; the Linux job separately proves the
AppImage replacement path. These checks do not replace production Developer ID
signing, Apple notarization, or publicly trusted Windows Authenticode
certification. The workflow publishes a uniquely tagged, non-latest GitHub
prerelease, verifies the downloaded remote inventory, and deletes the release
and tag after testing. GitHub currently permits an immutable release itself to
be deleted and its tag to be removed afterward, although that tag name can
never be reused; every dispatch therefore uses a unique tag. If repository
policy refuses deletion, the workflow fails closed, records the retained
evidence in its summary, and requires manual removal before repository
visibility changes.

After the repository becomes public—and before announcing the first stable
release—a no-token N-1 to N canary against the real public GitHub Releases feed
is mandatory. The private-repository test cannot certify anonymous public asset
access.

Pushing an exact stable tag such as `v1.2.3` at the current reviewed `main`
commit runs clean native builds and sets the package version to `1.2.3`. Tag
builds fail closed unless macOS is signed and notarized and Windows is
Authenticode-signed. Electron Builder still runs
with `--publish never`: each native build produces its local `latest*.yml` and
blockmap files, and the release job owns publication. It verifies the exact
cross-platform asset names, metadata references, SHA-512 values, signatures,
notarization ticket, and generated `SHA256SUMS`; stages the assets on a draft;
compares the remote draft inventory to the verified local inventory; and only
then publishes it as the latest stable GitHub release. Publication is the
promotion gate that makes the version discoverable to installed applications.

Create a protected GitHub Actions environment named `release`, restrict it to
the stable release-tag pattern, and require maintainer approval. Store these
Actions secrets in that environment before a stable tag is pushed:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12`.
- `MAC_CSC_KEY_PASSWORD`: password for that certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`: Apple
  notarization credentials.
- `WIN_CSC_LINK`: base64-encoded Windows code-signing `.pfx`.
- `WIN_CSC_KEY_PASSWORD`: password for that certificate.

Also set the non-secret environment variable `WIN_CSC_PUBLISHER_NAME` to the
certificate's complete Subject distinguished name. The release fails unless
both Windows executables have that exact Authenticode subject and the packaged
`app-update.yml` pins the same name for update-signature verification.
Reissuing a certificate with the same Subject preserves continuity. If the
Subject must change, first ship a reviewed bridge release signed by the old
certificate that trusts both old and new Subject names; only a later release
may switch signing to the new certificate. Do not rotate the certificate and
trusted Subject in one release.

The built-in, job-scoped `GITHUB_TOKEN` publishes the release; no repository
credential is embedded in the application. The repository must be public
before the stable release job can publish. Enable GitHub's **immutable
releases** setting before the first public release so publishing locks the tag
and assets; the workflow queries that setting and fails before creating a draft
when it is disabled. Add a repository tag ruleset that restricts creation and
deletion of `v*` tags to release maintainers. The workflow independently
requires the tag to point at the fetched current `origin/main` commit, uploads
every asset while the release is a draft, refuses to replace an already
published release, and performs no writes after promotion.

Pull-request, `main`, and manual non-tag builds remain unsigned CI artifacts.
They include updater metadata for reproducibility checks but are never
published to the update feed.

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

To exercise the M3 shell path, select one exact pre-authorized live session in
an isolated packaged-app window:

```sh
SLIVER_GUI_M3_REAL_E2E=1 \
SLIVER_GUI_E2E_CONFIG=/absolute/path/operator.cfg \
SLIVER_GUI_E2E_SESSION_ID=<exact-session-id> \
npm run test:e2e:packaged-real-m3
```

`SLIVER_GUI_E2E_SESSION_NAME` may be used instead of the exact ID when it
matches exactly one live session. The harness starts one child shell and limits
cleanup to captured managed-resource IDs. Failure cleanup may invoke Kill only
through that exact main-owned resource; it never terminates an implant or
performs wildcard cleanup. Because upstream shell closure is best effort, an
unconfirmed orphan is a test failure rather than permission for broader remote
cleanup. The harness also verifies the exact `app.asar` adjacent to the selected
packaged executable before launch.

## Security boundary

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`, and webviews disabled.
- The main window installs a response-header Content Security Policy. Script
  directives allow local bundled JavaScript plus the narrow
  `wasm-unsafe-eval` capability needed to instantiate the verified local
  Ghostty runtime. Inline scripts, `unsafe-eval`, event handlers, workers,
  remote connections, objects, and frames remain blocked; `connect-src` and
  `worker-src` remain `none`.
- Navigation, new windows, device access, and all unrelated permissions are
  denied. The session grants only `clipboard-read` and
  `clipboard-sanitized-write` to the exact trusted main frame for the explicit
  operator Copy/Paste controls, which also require active user interaction.
  IPC accepts only that renderer URL, frame, and owning BrowserWindow.
- The preload exposes a frozen, typed set of narrowly scoped operations. Raw
  gRPC clients, tokens, certificates, keys, and arbitrary filesystem access are
  never exposed to renderer code.
- Interactive shell bytes use a versioned MessagePort plane with one-use,
  exact-window attachment capabilities, strict sequence and credit accounting,
  bounded frames, queues, quotas, and timeouts. The renderer sees opaque
  resource IDs rather than upstream tunnel IDs, and payload bytes never enter
  broad IPC snapshots, React state, Activity, logs, or content-bearing metrics.
  Pop-out uses a main-owned atomic ownership transfer into one hardened
  dedicated BrowserWindow; tickets are revoked and reissued for the exact new
  renderer document rather than made cross-window.
- `ghostty-web@0.4.0` and its `ghostty-vt.wasm` runtime are pinned and verified
  against packaged provenance before the renderer receives an isolated byte
  copy. The terminal does not fetch code or enable host-effect callbacks;
  hostile OSC and string-control sequences are filtered before rendering.
- Server events are invalidation hints rather than authoritative state. The GUI
  refetches snapshots after relevant events, mutations, and reconnects because
  the upstream event broker can drop events under pressure.

## Current upstream limitations

- Runtime TCP staging works, but upstream Sliver does not completely persist
  and restore TCP staging-listener configuration across server restarts.
- The console's `RestartJobs` behavior is not exposed because the backend RPC
  does not safely represent a single listener restart. Stop and explicit start
  are supported.
- The upstream shell API does not report whether a requested PTY was actually
  allocated. Linux and macOS therefore display `requested-unconfirmed` and
  treat resize as best effort; Windows shells are forced to non-PTY mode.
- Shell Close confirms local managed-stream closure and sends bounded
  best-effort `exit` and `logout` requests, then waits boundedly for the exact
  remote EOF before closing the transport. A missing EOF is not proof that the
  remote process terminated; Kill remains the forceful path.
- Detached shell scrollback and reattachment stay local to the same live client
  and exact main-owned shell surface. The owning workspace can transfer shells
  to one hardened dedicated window and re-dock them when it closes; arbitrary
  windows cannot claim them. Reattachment after application restart, backend
  replacement, or target loss is not supported.
