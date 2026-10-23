<p align="center">
  <img src="build/icon1a-dark.png" alt="Sliver GUI icon" width="160" height="160">
</p>

<h1 align="center">Sliver GUI</h1>

<p align="center">
  <a href="https://github.com/sliverarmory/sliver-gui/releases/latest">Download the latest release</a>
</p>

Sliver GUI is a cross-platform Electron desktop application for Sliver. It
combines backend connections, live status views, dedicated workspaces, and a
native Sliver console in a React interface built with HeroUI, HeroUI Pro, and
Font Awesome.

## Features

- Multiple application windows with saved operator configurations, shared
  connections for matching configurations, and independent workspace state.
- An Overview topology view, Sessions and Beacons dashboards, and dedicated
  interaction workspaces with Files, Processes, Environment, Registry, and
  Activity panels.
- Generation, builds and profiles, jobs and listeners, Loot, and Credentials
  views.
- Hosted Websites with site creation/deletion, standalone Monaco text editing,
  file and recursive directory imports, content replacement/deletion, MIME
  updates, and save-copy actions directly from content rows or source previews.
  Browser previews serve current content and website resources from a temporary
  loopback HTTP server. Read-only Monaco source and binary hex views remain
  available. See [website limits and preview security](docs/website-preview-security.md).
- Dedicated Sliver console and managed SSH windows with tabbed Ghostty
  terminals.
- A standalone **File → Remote Desktop** client powered by IronRDP, with direct
  TLS connections with default NLA or remote-screen sign-in, saved profiles, certificate review, tabbed desktops,
  explicit text clipboard, and a sandboxed canvas viewer. It works without an
  operator configuration or a Sliver server connection. See
  [RDP usage](docs/rdp-client.md) and
  [architecture and verification](docs/rdp-client-design.md).
- Separate Armory, Network, and Cloud Deployment windows, including AWS and
  Azure account integration.
- A Cloud Deployment DNS manager for Route 53 and Azure DNS, with zone and
  all-zones record views and record editing.
- Configurable keyboard shortcuts, application appearance, and update controls.
- Command palette navigation to live sessions and beacons by name, with host, user, and ID details to distinguish matching names.

The GUI does not implement every upstream command or option. Operator
connections use mTLS; WireGuard operator configurations are recognized but
cannot connect. See the [operator parity report](docs/operator-parity.md) for
tracked coverage and the feature documents below for specific boundaries.

## Development

### Requirements

- Node.js 24.15 or newer on the 24.x line, or Node.js 26 or newer.
- npm 11.19 or newer.
- rustup for the bundled RDP helper; `npm run setup:rdp` installs the pinned
  Rust 1.94.1 toolchain and platform targets.
- A HeroUI Pro license and authentication for its package artifact, you only need this license if you want to build the code from scratch. You can download [prebuilt binaries from the Github releases](https://github.com/sliverarmory/sliver-gui/releases).

The supported versions and locked dependencies are recorded in
[package.json](package.json) and [package-lock.json](package-lock.json).
Application code uses strict TypeScript; build helpers use Node.js ES modules.

### Run locally

```sh
npm ci --strict-allow-scripts
npx heroui-pro login
npx heroui-pro install --yes
npm run setup:rdp
npm run dev
```

The HeroUI login/install steps are needed for initial workstation setup; they
can be skipped when `HEROUI_AUTH_TOKEN` is already configured for installation.
Keep credentials out of tracked files.

`npm run dev` builds and launches the static application at
`sliver://app/index.html`, using the production content security policy.
It also builds the host RDP helper from the pinned IronRDP fork and stages the
checksum-pinned Beagle release for this machine. Ordinary TypeScript builds and
unit tests do not require compiling Rust or downloading Beagle.
Restart the command after source changes; this workflow does not use HMR.

The TypeScript client is installed from the pinned `sliver-script` npm package.
An adjacent client checkout is not needed. Ordinary application development
does not require a Sliver source checkout; building the native console does.

### Local settings and configurations

The default Sliver client root is `~/.sliver-client`; `SLIVER_CLIENT_ROOT_DIR`
can select another root. Application preferences, including Overview graph
options, are saved in `gui/application-settings.json`; workspace zoom is saved in
`gui/workspace-zoom.json`, and text editor preferences in
`gui/text-editor-settings.json` beneath that root. The GUI discovers existing
operator configs in `configs/` and updates the
open selector when a valid config is saved there. It saves configs selected
through Import as private file references in `gui/operator-configs.json`.
Import and Forget do not copy or delete the source configs.

Remote Desktop profiles and endpoint certificate pins live in `gui/rdp.json`.
Passwords are omitted by default, can be retained until app exit, or can be
encrypted with the operating system's secure storage. Persistent passwords are
unavailable when Linux selects an unencrypted key store. Clipboard transfer is
explicit and limited to text; closing an RDP tab disconnects without logging
off the remote Windows account.

**Settings → General → Appearance → Disable window transparency** turns off
native window glass immediately across the app. The switch is off by default,
so transparency remains enabled where supported. It is saved with the other
application preferences and takes precedence over terminal transparency.

Ghostty-compatible terminal colors are configured in **Settings → Terminal** and
saved to `gui/ghostty/config`. Custom themes belong in `gui/ghostty/themes/`;
installed native Ghostty themes are discovered automatically. See
[terminal appearance and Ghostty themes](docs/terminal-appearance.md) for config
sharing, the Monaco editor, platform transparency support, and runtime limits.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the main/preload and renderer TypeScript projects. |
| `npm test` | Run Vitest unit and component tests. |
| `npm run test:watch` | Run Vitest interactively. |
| `npm run test:e2e:electron` | Build and exercise Electron through its renderer, preload, and IPC. |
| `npm run protocol:check` | Verify the pinned client, upstream baseline, and parity artifacts. |
| `npm run build` | Typecheck and build application output in `dist/`. |
| `npm run build:console` | Build the pinned native Sliver console. |
| `npm run build:rdp:host` | Build and verify the RDP helper for this machine. |
| `npm run build:rdp` | Build the RDP packaging target, including both macOS slices. |
| `npm run test:rdp:native` | Run the Rust runtime tests. |
| `npm run build:beagle:host` | Download, stage, and verify the pinned Beagle release for this machine. |
| `npm run build:beagle` | Prepare bundled Beagle for packaging, including both macOS slices. |
| `npm run test:beagle:loader` | Exercise bundled Beagle through the real Electron ASAR loader. |
| `npm run test:e2e:beagle:bundled` | Open AD Explorer with fresh settings and query bundled Beagle. |
| `npm run package` | Create an unpacked application under `release/`. |
| `npm run dist` | Create platform installers under `release/`. |
| `npm run test:e2e:packaged` | Verify and test an existing unpacked application against a local fixture. |

Unit and component tests live beside source files; Electron scenarios live in
`src/e2e/`. Actual-server tests are separate, opt-in checks requiring configured
disposable infrastructure. A fixture test does not establish live-server or
installed-package compatibility.

The protocol check uses Go and fetches the pinned upstream source into a
temporary directory. See [protocol documentation](protocol/README.md) for
provenance checks and using an explicitly selected local baseline.

### Native console and packaging

Console and distribution builds require Go 1.27.1 and a clean Sliver checkout
at the commit and tree recorded in
[console provenance](protocol/sliver-console-provenance.json). Place it in
`sliver/` or set `SLIVER_SOURCE_DIR`. The console build validates the source;
it does not fetch or modify that checkout.

The build disables automatic Go toolchain switching. Put the required Go binary
on `PATH` or set `SLIVER_GO_BINARY` to its absolute path. Universal macOS console
builds require macOS and `/usr/bin/lipo`.

`npm run package` and `npm run dist` prepare the native runtime, console, and
license inventory before packaging. Generated output under `dist/`, `release/`,
`native/sliver-console/`, and `.e2e-dist/` is ignored by Git.
The generated RDP executables, provenance, and Cargo license inventory under
`native/rdp/bin/` are also ignored. The helper source and lockfile are tracked.
Beagle release archives are pinned in `protocol/beagle-provenance.json` and
downloaded during native build preparation. Its generated executable, provenance,
and license inventory under `native/beagle/bin/` are ignored, as is the generated
`native/beagle/packaged-provenance.json` ASAR trust anchor. Universal macOS builds
combine the verified Intel and Apple Silicon release executables with `lipo`.

## Packages and updates

The CI packaging matrix is:

| Platform | Packages | Automatic updates |
| --- | --- | --- |
| macOS universal | DMG and ZIP | Installed app downloads the ZIP update. |
| Windows x64 | NSIS installer and portable EXE | NSIS installations only; portable builds update manually. |
| Linux x64 | AppImage and DEB | AppImage only; DEB packages update manually. |

Supported packages are configured to check GitHub Releases, download updates
in the background, and install on **Restart to update** or normal application
exit. Stable builds do not accept prerelease updates. No GitHub token is
embedded in the application.

The initial `v0.0.1` release uses persistent self-signed code-signing certificates.
macOS **Check for Updates** offers the native certificate trust dialog before
the first update check; the app must first be allowed to launch through
Gatekeeper. Windows installations need the public signing certificate trusted
on the destination machine. See [self-signed installation and updates](docs/self-signed-updates.md)
for the trust bootstrap, public fingerprints, and release key policy.

Build targets and minimum-runtime certification are separate. See the
[platform support ADR](docs/adr/0001-platform-support.md) for runtime requirements,
certification status, and signing/update policy.

## Security boundaries

Electron main owns backend clients, operator configuration secrets, native
processes, and filesystem access. Sandboxed renderers use narrowly scoped,
typed preload APIs; IPC validates the calling document and owning window.

The production CSP blocks inline scripts and renderer network connections while
allowing bundled workers and local WebAssembly runtimes. Application documents
are served through `sliver://app`; external documentation and cloud sign-in
open in the system browser. Destructive operations retain main-process
validation and review flows. Do not weaken these boundaries for development.

## Documentation

- [Contributor guidelines](AGENTS.md)
- [Overview topology](docs/overview-topology.md)
- [Armory package management](docs/armory.md)
- [Standalone Text Editor](docs/text-editor.md)
- [AWS authentication](docs/aws-login.md) and [Azure authentication](docs/azure-login.md)
- [Cloud DNS management](docs/cloud-dns.md)
- [Managed software on cloud servers](docs/cloud-managed-software.md)
- [Protocol baseline and provenance](protocol/README.md)
- [Operator parity report](docs/operator-parity.md)
- [Beacon command coverage roadmap](docs/beacon-command-roadmap.md)
- [Platform support and release policy](docs/adr/0001-platform-support.md)

## License

Sliver GUI is licensed under [GPL-3.0-or-later](LICENSE). Third-party components,
including HeroUI Pro, retain their own terms. See the
[licensing notes](LICENSES/LICENSING.md) for attribution and distribution
constraints.


### Active Directory Explorer (Beagle)

Open **View → AD Explorer** for a standalone local AD workspace. Create a project,
choose **Import data** to load SharpHound ZIP/JSON collections, then search entities,
run parameterized Cypher or a built-in BloodHound query, and inspect the React Flow
graph or table results. Object details support owned/tier-zero tags, relationship
expansion and path endpoints; relationship details expose Beagle's composition
workflow. Custom queries are saved per project, and **Export graph** writes the
complete canonical graph through a native save dialog.

[Beagle](https://github.com/sliverarmory/Beagle) is bundled with native packages
and available automatically. The application verifies its pinned provenance,
executable identity, and helper protocol before launching it. Downloads happen
during build preparation; the installed application uses its bundled executable.

To use a custom Beagle build with the `helper-stdio` subcommand, choose it in
the window's runtime settings. The selection pins its SHA-256, checked before
every helper launch. Select it again after intentionally upgrading that file;
existing unpinned saved paths also require reselection. Alternatively, configure
both `SLIVER_BEAGLE_BINARY` (an absolute path) and `SLIVER_BEAGLE_SHA256` (the expected
SHA-256). Explicit overrides retain their verification requirements. There is no
automatic PATH search.

Project databases live under Electron's user-data directory in `beagle/`; imports
merge into the selected project and run analysis. Use a new project for a separate
dataset. Cypher is read-only; the desktop bridge also blocks file-loading and
dynamic-query functions so queries cannot bypass native file selection. Queries have a 30-second backend timeout and a
40-second request deadline; imports/analysis have a five-minute deadline. One
persistent helper holds the selected project's database and receives typed JSON
requests over stdin. Project changes stop the previous helper before opening the
next database. A deadline or protocol failure terminates the helper; interrupted
mutations are never automatically replayed. Display
limits are 5,000 rows, 1,500 nodes and 3,000 relationships, with visible truncation.
The backend response ceiling is 32 MiB, including exports.

Run the real helper integration test with synthetic collection data:

```sh
npm run build:beagle:host
SLIVER_BEAGLE_E2E_BINARY=/absolute/path/to/beagle npm run test:beagle:helper
```

Use the prepared `native/beagle/bin/beagle` (`beagle.exe` on Windows) or an
explicit custom build. CI exercises the prepared helper without private data.
After preparing the helper, `npm run test:e2e:beagle:bundled` opens a fresh
AD Explorer window without a runtime setup prompt and executes a local query.
Its screenshot is written to `artifacts/e2e/beagle-bundled.png`.

Run focused native validation with an existing private GOAD collection:

```sh
SLIVER_BEAGLE_E2E_BINARY=/absolute/path/to/beagle \
SLIVER_BEAGLE_E2E_COLLECTION=/absolute/path/to/goad.zip \
npm run test:e2e:beagle
```

See [the implementation plan](docs/beagle-implementation-plan.md) and
[compatibility evidence and reproduction instructions](docs/beagle-verification.md).
The [persistent helper architecture](docs/beagle-helper.md) describes its protocol,
executable trust, environment and lifecycle.
The private lab collection and generated databases are excluded from version control.
