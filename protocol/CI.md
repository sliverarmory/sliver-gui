# Protocol and parity CI wiring

The root package and workflow wiring is checked in. The protocol generator does
not mutate those integration files. `package.json` exposes these scripts:

```json
{
  "scripts": {
    "protocol:check": "node scripts/protocol-check.mjs",
    "protocol:fetch": "node scripts/protocol-fetch-baseline.mjs",
    "protocol:protobuf": "node scripts/protocol-generate-protobuf.mjs",
    "protocol:vendor": "node scripts/protocol-verify-vendor.mjs",
    "parity:generate": "node scripts/parity-generate.mjs",
    "parity:check": "node scripts/parity-check.mjs"
  }
}
```

Arguments follow npm's `--` separator. For example:

```sh
npm run parity:check -- --source /tmp/sliver-baseline --regenerate
npm run protocol:protobuf -- --source /tmp/sliver-baseline --check
```

The workflow runs a dedicated Linux protocol job before the platform build
matrix. Its toolchain must be exact; a floating `24`, `latest`, or default
system `protoc` does not satisfy the provenance lock.

```yaml
protocol-parity:
  name: Protocol and parity drift
  runs-on: ubuntu-22.04
  timeout-minutes: 30
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false
    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: 24.0.0
        cache: npm
    - uses: actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6
      with:
        go-version: 1.25.8
        cache: false
    - uses: arduino/setup-protoc@c65c819552d16ad3c9b72d9dfd5ba5237b9c906b # v3
      with:
        version: "35.1"
        repo-token: ${{ github.token }}
    - name: Pin npm
      run: npm install --global npm@11.19.0 --ignore-scripts
    - name: Install locked protobuf generator
      run: npm ci --ignore-scripts --prefix protocol/protobuf-toolchain
    - name: Verify exact toolchain and generated artifacts
      run: npm run protocol:check
```

`protocol:check` fetches both upstream repositories into fresh temporary
directories at their full locked commits; it never consults an adjacent
checkout. It then verifies the regenerated command inventory/report,
protobuf bytes and descriptor semantics, replayable handwritten wrapper
overlay, bundle, and the exact vendored source allowlist. A command-tree drift
prints added, removed, renamed, and re-gated nodes before failing.

Do not pass `--allow-node-drift` in CI. That option exists only so a developer
can compare deterministic bytes on a non-pinned host while preparing to rerun
the authoritative job under Node 24.0.0.
