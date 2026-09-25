# Local Armory Package Manager

Open **Armory → Manage** from the native menu. The standalone window works without a server connection:

- **Manage** lists locally installed aliases, extensions, and BOFs, with package details, update checks, and removal.
- **Install** searches enabled sources, installs packages and bundles with their dependencies, and imports signed local `.tar.gz` packages through native file pickers.
- **Armories** edits the console-compatible repository list and trusted Minisign keys. Authorization headers stay in Electron main and are never returned to the renderer.

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

Already-installed packages are inventoried from disk; their presence does not imply retrospective signature verification. The Armory management window never runs package hooks or binaries.

## Execute installed BOFs

Open a session's **Execution** workspace, or a beacon's **Advanced execution** section, and select **BOFs**, immediately to the right of **Process**. **New Execution** lists BOF commands from installed `extensions/*/extension.json` manifests under the same Sliver client root used by Armory. Select a command to fill in the manifest's ordered string, wide-string, integer, short, or local-file arguments. Optional values use their manifest defaults. The selected object must match the target OS and architecture. Built-in BOFs require a target that advertises BOF execution. A legacy BOF with a `coff-loader` dependency also requires the matching installed loader artifact for that target.

The Electron main process reads the manifest and object, packs arguments in Sliver's BOF wire format, and calls the fixed `CallExtension` RPC for the selected target. Legacy BOFs first register their installed loader and pass the BOF object and packed arguments through that loader. The renderer receives neither a general RPC interface nor local artifact paths. Execution history stays in memory for the current window and target. Submitted beacon results are checked automatically while their execution is selected, with a manual refresh option. The output panel shows captured stdout and stderr in the same terminal used for Process results, with copy, save, and Add to Loot actions.

## Validation

Run `npm test` for the signature, archive, service, IPC, preload, and renderer checks. `npm run test:e2e:electron` includes a native Armory window test using an inert, independently signed package and a temporary console-compatible root. It verifies the restricted bridge, menu navigation, signed installation, console-format inventory changes, and removal without executing package artifacts.

Run `npm run test:e2e:bofs` for the isolated Electron BOF workflow. It installs two inert direct BOF fixtures and a legacy loader fixture into a temporary Sliver client root and verifies the selected BOF, packed arguments, session and beacon RPC dispatch, history, terminal output, and copy controls through the fake client.

The opt-in live check needs a Darwin/arm64 Sliver server binary built from the pinned source and locally installed `sa-dir` and `sa-nslookup` Armory packages:

```sh
SLIVER_GUI_BOF_LIVE_E2E=1 \
SLIVER_GUI_BOF_E2E_SERVER_BINARY=/absolute/path/to/sliver-server \
SLIVER_GUI_BOF_E2E_ARMORY_ROOT=/absolute/path/to/.sliver-client/extensions \
npm run test:e2e:bof-live
```

That test creates an isolated loopback server and one disposable local session, runs both installed BOFs through the production GUI, checks argument-dependent terminal output and Copy output, and removes its exact processes and temporary files.
