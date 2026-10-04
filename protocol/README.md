# Sliver protocol baseline

`sliver-baseline.json` is the GUI-owned source of truth for the Sliver revision
used by operator-command parity and native-console source alignment. The full
Sliver commit and tree are verified before inventory generation. Tools never
implicitly read the ignored adjacent `./sliver` checkout.

The TypeScript client is the exact `sliver-script@2.0.0-rc.5` registry package
installed by the root `package-lock.json`. `sliver-script-provenance.json` pins
its registry tarball, integrity and shasum, source tag and commit, and hashes of
the installed package manifest plus its integration and protobuf locks. The
package's own `protobuf.lock.json` is authoritative for its generated API. The
verifier rejects a local link or any package-lock, metadata, or package-tree
drift, and requires the package's Sliver source commit and tree to match the GUI
baseline.

The checked-in parity artifacts are deliberately split:

- `docs/operator-parity.generated.json` contains deterministic upstream facts;
- `docs/operator-parity.annotations.json` contains reviewed product decisions;
- `docs/operator-parity.md` is the merged human-readable release report.

Protobuf generation and its compiler/generator toolchain belong to the generic
`sliver-script` project. This repository locks the complete installed package,
checks that its integration metadata remains consumer-neutral, and confirms that
its protobuf source revision matches the GUI baseline. It does not reinterpret
the upstream output/toolchain lock, run `protoc`, carry a second generator, or
rewrite the package. Protocol changes must be integrated and published upstream
before this repository pins a new exact version.

Restriction values record the upstream command-tree visibility contract and
their evidence source. Unannotated implant commands use the `SliverCommands`
visibility default; `console-hidden` annotations narrow or inherit that scope.
These visibility facts do not replace stricter main-process runtime capability
checks. Every reviewed command also has a stable test contract ID; an assigned
ID does not itself claim that the future milestone test has passed.

After installing the exact root dependency, the direct checks are:

```sh
npm ci --omit=dev --ignore-scripts
npm run protocol:client
npm run protocol:fetch -- --destination /tmp/sliver-baseline
npm run parity:check -- --source /tmp/sliver-baseline --regenerate
npm run protocol:check -- --sliver-source /tmp/sliver-baseline
```

For an explicitly selected local Sliver checkout, `--source` or
`--sliver-source` is accepted only after its full commit and tree match the
lock. It is never selected automatically. `protocol/CI.md` documents the
current root package scripts and the exact pinned protocol workflow job.
