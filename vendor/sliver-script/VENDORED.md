# Vendored sliver-script source

This directory contains the minimal build-time source snapshot of
[`sliverarmory/sliver-script`](https://github.com/sliverarmory/sliver-script)
used by Sliver GUI.

- Snapshot commit: `01f1029cc17898da681e52b64af4a708ff82c3d3`
- Published upstream base: `837fb21c5291eef6285c2e168eef0620b99a5394`
- Sliver command/protobuf source: `9ff9b55352eb1c8f2ff6a906bb691e9cee5bcaa9`

The authoritative machine-readable locks are
`protocol/sliver-baseline.json` and `protocol/sliver-script-provenance.json`.
They separate three inputs that must not be reviewed as one opaque diff:

1. the unpublished handwritten wrapper snapshot reconstructed from the bundle;
2. five generated protobuf clients reproduced from Sliver `9ff9b553...`; and
3. the GUI handwritten overlay in
   `protocol/sliver-script-handwritten-overlay.patch`.

The old `4ef8644...` attribution was incorrect. The historical generator script
preferred an adjacent `../sliver` checkout, so its declared submodule revision
did not identify the protobuf bytes. Regeneration from `9ff9b553...`, with the
locked generator, options, input order, and output order, matches all five
checked-in files byte-for-byte and matches the locked descriptor set hash.

The snapshot commit is not published on the referenced remote. Its exact Git
objects are retained in `sliver-script-snapshot.bundle`, with the public base
as the bundle prerequisite. The historical two-commit patch series remains in
`patches/` as archival evidence; it is not used as the protobuf or GUI overlay
layer. Verify and import the snapshot with:

```sh
git clone https://github.com/sliverarmory/sliver-script.git
cd sliver-script
git checkout 837fb21c5291eef6285c2e168eef0620b99a5394
git bundle verify /path/to/sliver-gui/vendor/sliver-script/sliver-script-snapshot.bundle
git fetch /path/to/sliver-gui/vendor/sliver-script/sliver-script-snapshot.bundle \
  HEAD:refs/heads/sliver-gui-snapshot
git rev-parse refs/heads/sliver-gui-snapshot
```

The final command must print
`01f1029cc17898da681e52b64af4a708ff82c3d3`.

For a complete reproducibility check, fetch both exact source checkouts into
explicit locations and run:

```sh
node scripts/protocol-fetch-baseline.mjs --destination /tmp/sliver-baseline
node scripts/protocol-fetch-wrapper-base.mjs --destination /tmp/sliver-script-base
npm ci --ignore-scripts --prefix protocol/protobuf-toolchain
node scripts/protocol-generate-protobuf.mjs --source /tmp/sliver-baseline --check
node scripts/protocol-generate-wrapper-overlay.mjs --source /tmp/sliver-script-base --check
node scripts/protocol-verify-vendor.mjs --wrapper-source /tmp/sliver-script-base
```

The protobuf generator is pinned to `protoc` 35.1, Node 24.0.0, npm 11.19.0,
`ts-proto` 2.11.4, TypeScript 5.8.3, `ts-poet` 6.12.0, and `dprint-node`
1.0.8. CI must not use `--allow-node-drift`; that switch is only for comparing
bytes on a developer host before entering the pinned Node environment.

The upstream tests, generated `lib` output, documentation site, examples, and
nested Sliver checkout are omitted because they are not required to build the
GUI. The upstream `LICENSE`, `README.md`, package manifest, TypeScript config,
and required runtime sources are retained. Every retained source file is
allowlisted and hashed in the provenance manifest. The generated `lib`
directory remains ignored and is rebuilt by the root `npm run build:client`
command.

The current handwritten overlay replaces the former generic approximately
2 GiB gRPC allocation limit with bounded control, inventory, task-content,
workbench-artifact, and artifact channels. The session workbench's binary RPCs
have a dedicated 66 MiB wire allocation and a separately enforced 64 MiB
decoded-payload ceiling; they do not inherit the legacy 256 MiB artifact
channel. The overlay also supplies a stable DNS-form TLS authority for direct
IP-literal targets, because Node TLS does not accept an IP literal as SNI, and
preserves the configured DNS authority when traffic traverses the loopback
proxy. This changes authority/SNI selection only; the configured Sliver CA,
client certificate, private key, and token remain the authenticated material.

The M1 overlay adds explicit typed wrappers for target inventory and presence,
named target lifecycle operations, ping and environment mutation,
beacon reconfiguration and session conversion, and beacon-task
list/fetch/cancel. It also converts public whole-second deadlines to the
nanosecond int64 strings expected by `commonpb.Request.Timeout`, matching the
canonical Go client without passing imprecise numbers through protobuf. These
are reviewed named methods, not an arbitrary RPC dispatcher; the Electron
main-process adapter and operation registry apply a narrower closed allowlist
before renderer input can reach them. The packaged RPC domains, M1 allowlist,
and timeout rules are documented in `docs/rpc-message-budgets.md`.

The session-first M2 overlay adds named session wrappers for identity and
environment reads, network inventory, bounded filesystem operations and
transfers, process inventory and dumps, Windows service operations, and Windows
registry operations. Binary screenshot, download, upload, process-dump, and
registry-hive calls use the isolated workbench-artifact channel and validate
decoded payload sizes in the wrapper before main-process publication. These
wrappers always construct their protobuf requests from typed parameters and a
main-owned session ID. Tail uses an explicit validated from-end option that maps
to the upstream negative `MaxBytes` convention, and upload responses remain
available to the main-owned mutation classifier instead of being collapsed by
the wrapper. There is still no arbitrary method-name or request-object
dispatcher. Beacon-mode M2 support has not landed and remains required before
M2 can be complete.

Packaged WireGuard operator transport and native-helper certification are
deferred beyond M0; mTLS is the M0 packaged transport baseline. This does not
change the independently classified implant-side WireGuard commands.

The snapshot is vendored because its GUI-facing API commits are not currently
available from the upstream remote. Once those commits are published, prefer a
pinned npm package or a non-recursive Git submodule and remove this snapshot in
the same change.
