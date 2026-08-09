# Sliver protocol baseline

`sliver-baseline.json` is the single source of truth for operator-command and
protobuf provenance. The full Sliver commit and tree are verified before any
inventory or protobuf generation. Tools never implicitly read the ignored
adjacent `./sliver` checkout.

The checked-in parity artifacts are deliberately split:

- `docs/operator-parity.generated.json` contains deterministic upstream facts;
- `docs/operator-parity.annotations.json` contains reviewed product decisions;
- `docs/operator-parity.md` is the merged human-readable release report.

The protobuf outputs under `vendor/sliver-script/src/pb` are generated from the
same pinned Sliver commit. Handwritten wrapper changes are provenance-reviewed
separately and must never be hidden inside a generated-code delta.

Restriction values record the upstream command-tree visibility contract and
their evidence source. Unannotated implant commands use the `SliverCommands`
visibility default; `console-hidden` annotations narrow or inherit that scope.
These visibility facts do not replace stricter main-process runtime capability
checks. Every reviewed command also has a stable test contract ID; an assigned
ID does not itself claim that the future milestone test has passed.

The root package scripts invoke these direct commands:

```sh
node scripts/protocol-fetch-baseline.mjs --destination /tmp/sliver-baseline
node scripts/protocol-fetch-wrapper-base.mjs --destination /tmp/sliver-script-base
node scripts/parity-generate.mjs --source /tmp/sliver-baseline
node scripts/parity-check.mjs --source /tmp/sliver-baseline --regenerate
node scripts/protocol-generate-protobuf.mjs --source /tmp/sliver-baseline --check
node scripts/protocol-generate-wrapper-overlay.mjs --source /tmp/sliver-script-base --check
node scripts/protocol-verify-vendor.mjs --wrapper-source /tmp/sliver-script-base
```

For an explicitly selected local checkout, `--source` is accepted only after
its full commit and tree match the lock. It is never selected automatically.
`protocol/CI.md` documents the wired root package scripts and exact pinned
protocol workflow job.
