# Local Armory Package Manager

Open **Armory → Manage** from the native menu. The standalone window works without a server connection:

- **Manage** lists locally installed aliases, extensions, and BOFs, with package details, update checks, and removal.
- **Install** searches enabled sources, installs packages and bundles with their dependencies, and imports signed local `.tar.gz` packages through native file pickers.
- **Sources** edits the console-compatible repository list and trusted Minisign keys. Authorization headers stay in Electron main and are never returned to the renderer.

Installed and catalog package rows show OS icons with architecture badges from their manifests, keeping architectures grouped under each OS. Multi-command packages combine their declared targets; unavailable metadata is labeled **OS/Arch unknown**. Hover over a badge to see the original OS/architecture identifiers.

Use the inline **All OS** and **All Arch** selectors alongside Search and package type to narrow either package list. OS and architecture must match the same declared target. Packages with unknown support and bundles appear when both platform selectors are unrestricted. Filter selections carry across tabs and refreshes.

## Console Interoperability

The GUI and its bundled console use `SLIVER_CLIENT_ROOT_DIR`, defaulting to `~/.sliver-client`. A separately launched console must use the same root. Packages and configuration use the console's original layout:

```text
~/.sliver-client/
  armories.json
  aliases/<command_name>/alias.json
  extensions/<package_name-or-legacy-command_name>/extension.json
```

All declared platform artifacts and the original manifest bytes are installed. BOFs are extension packages, so there is no separate GUI-only BOF directory or package database. The GUI rereads local inventory on focus, on refresh, and every five seconds while visible. A package installed or removed by the console is reflected there.

The console registers commands when it starts; changing files does not replace an existing console's in-memory command registry. Close and reopen its console tab after changing packages, or use the console's existing `aliases load <package-directory>/alias.json` or `extensions load <package-directory>` command. `armory refresh` refreshes the console's catalog, not its loaded command registry.

The reserved **Default** source follows the bundled console's pinned URL, public key, and enabled state. Custom sources can be enabled, disabled, edited, or removed. Existing `authorization_cmd` values are preserved when unrelated settings change, but the GUI never executes them; supply a static authorization header to use a source that otherwise requires a console authorization command. Supplying a header replaces that command in the shared configuration.

## Verification and Installation

Both the source index and package payload must pass Minisign verification. Package metadata is read only after authenticating the signature's trusted comment. The downloaded archive is verified with the package key from the signed index, its manifest must match the signed metadata, and its identity must match the selected package. Signed local imports require the archive, detached signature, and publisher's public key. There is no bypass for invalid or missing signatures.

The archive is decompressed and checked in memory before package files are staged on disk. The parser rejects traversal, absolute tar paths, links, special files, duplicate or conflicting paths, invalid checksums, truncated archives, and unsafe names across platforms. Required manifest artifacts must exist. Limits are 128 MiB compressed, 512 MiB expanded, 128 MiB per file, and 20,000 archive entries; dependency plans also have aggregate memory and depth limits. The console's leading-slash convention for manifest artifact paths is supported.

Only declared files are staged, with private file and directory permissions. Replacements retain backups until the install plan succeeds and roll back on failure. Conflicting commands and removals that would break installed dependencies are rejected. A failed signature or malformed archive never replaces an installed package. Concurrent external edits detected during installation or source updates require a refresh and retry.

Already-installed packages are inventoried from disk; their presence does not imply retrospective signature verification. Armory exposes no session, beacon, RPC, or package-execution API and never runs package hooks or binaries.

## Validation

Run `npm test` for the signature, archive, service, IPC, preload, and renderer checks. `npm run test:e2e:electron` includes a native Armory window test using an inert, independently signed package and a temporary console-compatible root. It verifies the restricted bridge, menu navigation, signed installation, console-format inventory changes, and removal without executing package artifacts.
