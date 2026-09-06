# Protocol and parity CI wiring

The root package and workflow wiring are integration files; the protocol
generator does not mutate them. The current `package.json` script surface is:

```json
{
  "scripts": {
    "protocol:check": "node ./scripts/protocol-check.mjs",
    "protocol:fetch": "node ./scripts/protocol-fetch-baseline.mjs",
    "protocol:protobuf": "node ./scripts/protocol-generate-protobuf.mjs",
    "protocol:client": "node ./scripts/protocol-verify-client-package.mjs",
    "parity:generate": "node ./scripts/parity-generate.mjs",
    "parity:check": "node ./scripts/parity-check.mjs"
  }
}
```

`protocol:client` replaces the historical wrapper reconstruction and vendor
verification commands. Arguments follow npm's `--` separator. For example:

```sh
npm run parity:check -- --source /tmp/sliver-baseline --regenerate
npm run protocol:protobuf -- --source /tmp/sliver-baseline --check
```

The workflow runs a dedicated Linux protocol job before the platform build
matrix. It installs the exact production subset of the root package lock (so
`node_modules/sliver-script` is the registry package without requiring the
HeroUI Pro development dependency) and the separate locked protobuf generator.
Its toolchain must be exact; a floating `24`, `latest`, or default system
`protoc` does not satisfy the provenance lock.

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
        go-version: 1.26.6
        cache: false
    - uses: arduino/setup-protoc@c65c819552d16ad3c9b72d9dfd5ba5237b9c906b # v3
      with:
        version: "35.1"
        repo-token: ${{ github.token }}
    - name: Set up exact npm
      run: npm install --global npm@11.19.0 --ignore-scripts
    - name: Install exact production client dependency
      run: npm ci --omit=dev --ignore-scripts
    - name: Install locked protobuf generator
      run: npm ci --ignore-scripts --prefix protocol/protobuf-toolchain
    - name: Verify native console build and provenance helper
      run: node --test scripts/buildSliverConsole.test.mjs scripts/prepareNodePtyRuntime.test.mjs
    - name: Verify protocol, protobuf, parity, and client package provenance
      run: npm run protocol:check
```

`protocol:check` first verifies the installed registry package against the root
package lock and `sliver-script-provenance.json`. It fetches only the pinned
Sliver repository into a fresh temporary directory, then verifies the command
inventory/report, Sliver commit and tree, protobuf input hashes, descriptor
semantics, locked toolchain, and exact regenerated equality with
`node_modules/sliver-script/src/pb`. The generator has no write mode.

Do not pass `--allow-node-drift` in CI. That option exists only so a developer
can run a focused comparison on a non-pinned Node host while preparing to rerun
the authoritative job under Node 24.0.0.
