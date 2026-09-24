# Sliver GUI

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
- Dedicated Sliver console and managed SSH windows with tabbed Ghostty
  terminals.
- Separate Armory, Network, and Cloud Deployment windows, including AWS and
  Azure account integration.
- A Cloud Deployment DNS manager for Route 53 and Azure DNS, with zone and
  all-zones record views and record editing.
- A Monaco Script Editor with a local script library, an isolated JavaScript
  runtime, and a script task manager.
- Configurable keyboard shortcuts, application appearance, and update controls.

The GUI does not implement every upstream command or option. Operator
connections use mTLS; WireGuard operator configurations are recognized but
cannot connect. See the [operator parity report](docs/operator-parity.md) for
tracked coverage and the feature documents below for specific boundaries.

## Development

### Requirements

- Node.js 24.15 or newer on the 24.x line, or Node.js 26 or newer.
- npm 11.19 or newer.
- A HeroUI Pro license and authentication for its package artifacts.

The supported versions and locked dependencies are recorded in
[package.json](package.json) and [package-lock.json](package-lock.json).
Application code uses strict TypeScript; build helpers use Node.js ES modules.

### Run locally

```sh
npm ci --strict-allow-scripts
npx heroui-pro login
npx heroui-pro install --yes
npm run dev
```

The HeroUI login/install steps are needed for initial workstation setup; they
can be skipped when `HEROUI_AUTH_TOKEN` is already configured for installation.
Keep credentials out of tracked files.

`npm run dev` builds and launches the static application at
`sliver://app/index.html`, using the production content security policy.
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

Build targets and minimum-runtime certification are separate. See the
[platform support ADR](docs/adr/0001-platform-support.md) for runtime requirements,
certification status, and signing/update policy.

## Continuous integration and releases

The [build workflow](.github/workflows/build-and-release.yml) runs protocol and
parity checks, Electron E2E, and native package jobs. Application jobs need the
`HEROUI_AUTH_TOKEN` Actions secret; public-fork pull requests run only the
non-secret protocol/parity job. Native jobs test unpacked applications against
a loopback mTLS fixture.

Stable publication is configured for exact `vX.Y.Z` tags at the current
`origin/main` commit. The workflow requires a public repository with immutable
releases enabled, macOS signing/notarization, Windows signing, and verified
assets before publishing through a draft release. Pull-request, `main`, and
manually dispatched non-tag builds produce CI artifacts. See the workflow for
signing inputs and publication gates, and the
[private updater workflow](.github/workflows/private-updater-e2e.yml) for the
separate update integration test.

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
- [Script Editor](docs/script-editor.md)
- [Standalone Text Editor](docs/text-editor.md)
- [AWS authentication](docs/aws-login.md) and [Azure authentication](docs/azure-login.md)
- [Cloud DNS management](docs/cloud-dns.md)
- [Protocol baseline and provenance](protocol/README.md)
- [Operator parity report](docs/operator-parity.md)
- [Platform support and release policy](docs/adr/0001-platform-support.md)

## License

Sliver GUI is licensed under [GPL-3.0-or-later](LICENSE). Third-party components,
including HeroUI Pro, retain their own terms. See the
[licensing notes](LICENSES/LICENSING.md) for attribution and distribution
constraints.
