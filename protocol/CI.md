# Protocol and parity CI wiring

The root package and workflow wiring consume the published client without
mutating or rebuilding it. The current `package.json` script surface is:

```json
{
  "scripts": {
    "protocol:check": "node ./scripts/protocol-check.mjs",
    "protocol:fetch": "node ./scripts/protocol-fetch-baseline.mjs",
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
```

The workflow runs a dedicated Linux protocol job before the platform build
matrix. It installs the exact production subset of the root package lock, so
`node_modules/sliver-script` is the registry package without requiring the
HeroUI Pro development dependency. Protobuf generation remains in upstream
`sliver-script`; this job consumes and validates the published package and its
locks without installing a second generator.

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
    - name: Set up exact npm
      run: npm install --global npm@11.19.0 --ignore-scripts
    - name: Install exact production client dependency
      run: npm ci --omit=dev --ignore-scripts
    - name: Verify native console build and provenance helper
      run: node --test scripts/buildSliverConsole.test.mjs scripts/prepareNodePtyRuntime.test.mjs
    - name: Verify protocol, parity, and client package provenance
      run: npm run protocol:check
```

`protocol:check` first verifies the installed registry package against the root
package lock and `sliver-script-provenance.json`. It validates the package's own
consumer-neutral integration metadata and checks the package's declared Sliver
commit and tree against the GUI baseline. The exact package tree and upstream
lock bytes are already pinned by provenance. The job then fetches only the pinned
Sliver repository into a fresh temporary directory and verifies the GUI command
inventory/report. The job neither generates protobuf downstream nor interprets
the upstream output/toolchain details.
