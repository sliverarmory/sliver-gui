# M0 verification evidence

- Date: 2026-08-09
- Milestone state: complete; operator accepted
- M1 state: implemented; awaiting operator acceptance
- Local package host: macOS arm64

## Protocol and provenance

The protocol check used an isolated checkout at exact Sliver commit
`9ff9b55352eb1c8f2ff6a906bb691e9cee5bcaa9`, not the ignored adjacent working
tree. The developer-host run used the explicit Node-drift allowance; CI pins
Node 24.0.0, npm 11.19.0, Go 1.25.8, and protoc 35.1 without that allowance.

```text
261/261 reachable static commands and reviewed annotations passed
5/5 protobuf files passed byte and descriptor-semantic verification
11 snapshot + 3 reviewed overlay + 5 generated vendor files verified
Handwritten client overlay verified
```

## Application checks

```text
npm test
  27 test files passed, 1 opt-in file skipped
  186 tests passed, 2 real-server tests skipped by the default invocation

npm run test:e2e:electron
  1 passed: production renderer -> frozen preload -> trusted IPC -> injected registry/client

npm run package
  typecheck, production build, release-content verifier, electron-builder,
  complete app.asar source/provenance/exclusion scan: passed

npm run test:e2e:packaged
  1 passed: packaged production app against the deterministic loopback mTLS fixture

npm run test:e2e:packaged-real
  1 passed: freshly packaged production app against an actual isolated Sliver server
```

The final unpacked macOS arm64 `app.asar` was 11,088,133 bytes with SHA-256
`81ab302fe69635f4fbde30551f51f402b1fd33655bc38a86c6e9ebadbfeaa1bf`.
The archive verifier found no E2E fixtures, source maps, or known test-secret
markers and confirmed the packaged license, client source, parity, protocol,
and provenance evidence.

## Actual-server coverage

An isolated real Sliver server listened only on loopback. The direct real-server
suite passed both tests and exercised version discovery, authoritative compiler
targets, event-driven listener lifecycle, real implant generation, archived
build staging, profile lifecycle, and cleanup.

The final packaged test then exercised the production executable through its
real renderer, frozen preload, trusted IPC handlers, connection registry, and
mTLS client. It verified the initial server-build mismatch notice, dismissed it,
and confirmed that no persistent degraded badge remained. It then started an
ephemeral listener job on loopback port `48991`, rendered the exact stop impact,
stopped only that job, observed its removal, independently verified its absence,
checked renderer/screenshot output for config secrets and local paths, and
disconnected. No listener remained on `48991`; the isolated server remains
running on loopback for continued manual verification and M1 development.

The final screenshot is generated locally at
`artifacts/e2e/packaged-real-server-darwin-arm64.png` and has SHA-256
`0eca281d04270e52e0ffca6b5f315ddecf5d1653a0ada1a0b3fbab2c213cb05c`.

## Certification boundary

This evidence validates the current macOS arm64 development host and the
workflow/build definitions. It does not claim installed-package certification
on the minimum-runtime matrix. Dedicated macOS Ventura 13.7.8 arm64 and Intel,
Windows 11 24H2 x64, and Ubuntu 22.04.5 x64 install lanes remain visibly pending
in ADR 0001. Unsigned tag automation remains draft-only.

Packaged WireGuard operator transport is explicitly deferred beyond M0. This
does not defer WireGuard listeners or implant C2 options.
