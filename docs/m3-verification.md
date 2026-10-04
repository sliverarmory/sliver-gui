# M3 managed-session-shell verification

Date: 2026-08-10
Status: **Accepted session-shell scope (2026-08-15)**
Acceptance-feedback follow-up: 2026-08-14

This record covers the session-shell-only M3 tranche. Automated implementation
and deterministic Electron evidence were completed before the operator tested
the GUI, supplied follow-up polish feedback, accepted this bounded scope, and
explicitly requested M4 on 2026-08-15. The acceptance does not expand M3 to any
of the deferrals below.

The pinned upstream Sliver command tree exposes interactive shells for sessions,
not beacons, so this milestone makes no beacon-shell claim. Port forwarding,
reverse forwarding, SOCKS, WireGuard networking, and generic tunnel-resource
parity remain assigned to M5.

## Acceptance-feedback follow-up (2026-08-14)

Operator feedback added two cross-cutting M1-M3 navigation and windowing
improvements without widening the delivered shell tranche:

- **Sessions** remains the first session-workbench breadcrumb and is now a
  bounded dropdown over exact, main-issued session target references. A switch
  is admitted only while the source and requested identities are still exact;
  stale, disconnected, or third-target races fail closed. If the source
  workspace owns managed shells, the UI warns the operator and requires
  confirmation before switching, with **Pop out managed shells** available to
  preserve intentional ownership first.
- The exact active session or beacon can open its whole **Interact** surface in
  a hardened native window. The launch URL carries only a static presentation
  marker. Electron main owns the destination authorization and stable target
  identity, rejects unregistered or recursive claims, and restores the same
  authorized identity across renderer reloads. The destination maintains its
  own operation history and interaction controller while observing the exact
  target's task and presence data; it does not copy source-window state or
  implicitly transfer managed shells.

This 2026-08-14 follow-up was acceptance evidence rather than the acceptance
decision itself. The later 2026-08-15 decision accepted the delivered scope and
unlocked M4 without transferring managed shells implicitly or expanding M3.
The historical automated results below remain the 2026-08-10 delivery record
and are not rewritten by this follow-up.

### Follow-up automated evidence

The 2026-08-14 integrated verification passed `npm run typecheck` and the full
unit/component suite: **66 test files passed and one was skipped; 749 tests
passed and two were skipped**. The production-renderer Electron lane also
passed its single current-slice journey. It opened exact session and beacon
interaction windows, exercised a visible operation control, proved source and
destination operation/shell isolation, rejected cross-mode retargeting,
quarantined target loss, restored the main-owned identity after reload, and
observed no HTTP or WebSocket escape.

## Delivered operator path

- The dedicated session workbench now places **Shell** immediately before
  **Activity**. Its managed-shell workspace supports start, bounded inventory,
  selection-driven attach, detach, close, kill, and switching among multiple
  managed shells. Selecting a detached shell attaches it directly; there is no
  separate Attach button.
- The workspace can transfer its exact managed-shell inventory into one
  hardened, main-created dedicated window. The URL contains only the static
  presentation marker; target references, resource IDs, and attachment tickets
  remain main-owned. Closing that window re-docks the shells when the original
  workspace is still bound to the same exact session.
- Desktop layouts use a resizable shell inventory and terminal area. Narrow
  layouts replace the persistent inventory with a controlled responsive sheet.
- The renderer cannot select a shell path. Electron main chooses the reviewed
  platform default (`/bin/bash` or `powershell.exe`). Linux and macOS request a
  24-row by 80-column PTY. Because the upstream
  protocol does not acknowledge PTY allocation, the UI labels it
  `requested-unconfirmed`. Windows always requests a non-PTY shell and sends no
  resize frames.
- Terminal resize is clamped to the shared wire limits, debounced, deduplicated,
  and emitted only for a resource that permits resize. The request is best
  effort; no confirmed remote resize state is presented.
- Operators can focus the terminal explicitly, copy its bounded selection, and
  paste through an explicit control. Multiline or control-character paste
  requires confirmation that shows metadata only, never clipboard content.
- Close and Kill are distinct reviewed actions. Close always tears down the
  local managed stream and sends bounded best-effort `exit` and `logout`
  requests, then waits up to two seconds for the exact tunnel's remote EOF
  before closing the transport. This prevents CloseTunnel from overtaking the
  graceful-exit frames, but it does not prove remote process termination when
  EOF never arrives. Kill invokes the available forceful remote action before
  closing the local resource.

## Bounded MessagePort plane

Shell payloads do not travel through broad invoke results or application
snapshots. Preload creates one MessageChannel and delivers the renderer port in
this exact versioned envelope with exactly one transferred port:

```text
{ source: "sliver-preload", type: "stream-port", v: 1, correlationId }
```

The matching main-process port is admitted only with an expiring, one-use
ticket bound to the exact BrowserWindow, renderer process, main frame, document,
backend, connection incarnation, and target fingerprint. Upstream tunnel IDs
stay in Electron main; renderer code receives opaque managed-resource and
per-attachment stream IDs.

The protocol enforces exact frame keys, fixed versioning, ordered sequence
numbers, credit-based data flow, 16 KiB payload frames, bounded early output and
detached scrollback, bounded control traffic, write serialization, fair
scheduling, and per-stream, per-window, per-backend, and whole-process quotas
and timeouts. Malformed, duplicated, over-credit, cross-stream, post-close, and
unsupported-resize frames fail closed. Owned payload buffers are cleared after
their synchronous consumer completes or when parsing rejects them.

Only lifecycle state, pressure, byte counts, queue depth, fixed close reasons,
and other content-free metrics enter renderer metadata. Terminal input/output,
clipboard payloads, upstream tunnel IDs, and detached scrollback do not enter
React state, broad IPC snapshots, Activity, logs, or content-bearing metrics.

## Pinned Ghostty runtime and hostile-output boundary

The integration pins `ghostty-web@0.4.0` from source commit
`9e4e126d89ac3537d2b2ebec075849851566de9f`. Its local
`ghostty-vt.wasm` asset is verified against SHA-256
`d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a`
before Electron main returns an independent byte copy. Each terminal creates an
isolated WASM runtime without renderer fetch, network, or worker access.

The response-header CSP adds only `wasm-unsafe-eval` for this verified local
runtime. Inline script, `unsafe-eval`, remote script, workers, objects, frames,
and connections remain blocked; `connect-src` and `worker-src` remain `none`.

Terminal output is treated as hostile before it reaches Ghostty. The bounded
streaming sanitizer removes OSC, DCS, APC, PM, SOS, raw C1 string controls,
hyperlink activation, OSC 52 clipboard writes, title changes, inline file/image
payloads, and bells while preserving ordinary UTF-8 and safe terminal layout
and CSI controls. Terminal title, notification, download, clipboard, link-open,
and other host-effect callbacks are not connected to remote output.

## Attachment and teardown semantics

- Intentional detach disposes the payload-bearing terminal surface and retains
  only bounded main-owned scrollback for a one-use reattachment.
- Reattachment is available only to the same live client and exact owning shell
  surface. Main can atomically transfer ownership between a source workspace
  and its one dedicated shell window: old tickets are revoked, active ports are
  detached, resource IDs and bounded queues are preserved, and fresh tickets
  bind the destination renderer process, frame, and document. Generic or stale
  windows remain denied. Reattachment does not survive application restart,
  backend replacement, connection-incarnation change, or target loss.
- Navigation away from the exact session quarantines stale callbacks and
  detaches the renderer. Unexpected port loss, route replacement, window close,
  renderer destruction, target loss, backend disconnect, connection rebind,
  timeouts, and application shutdown close or detach according to the fixed
  lifecycle policy; a shell is never silently recreated.
- Detached scrollback is destroyed when the managed resource closes and cannot
  be recovered.

## Automated evidence

The final integrated unit/component suite exercised shared frame parsers,
preload handoff, wrapper shell/tunnel bounds, stream admission and lifecycle,
runtime provenance, output sanitization, Ghostty rendering, renderer transport,
managed-shell states, Strict Mode remount behavior, and session-workspace
integration:

```sh
npm test
```

Result: **55 test files passed and one was skipped; 671 tests passed and two
were skipped** in 5.63 seconds.

The deterministic Electron lane rebuilt the production renderer, frozen
preload, trusted IPC, and injected-client boundary and exercised start, terminal
input/output, initial resize, hostile output, selection-driven reattachment,
atomic pop-out/re-dock without shell recreation, source-authority denial,
duplicate-window focus, close review, target quarantine, content-free
diagnostics, and external-network denial:

```sh
npm run test:e2e:electron
```

Result: **1 test passed, zero failed, zero skipped** in 13.51 seconds. The
deterministic capture at `artifacts/e2e/m3-session-terminal.png` had SHA-256
`9d7f36669824ed88f1cbd9684cd51be764bcf45662257cc83cb50545d87d9c41`.

The pinned provenance and reviewed parity lanes are:

```sh
npm run protocol:ghostty
npm run parity:check -- --source <pinned-sliver-source> --regenerate
```

The parity review keeps `implant.shell`, `implant.shell.ls`,
`implant.shell.attach`, and `implant.shell.kill` in progress under M3 with
stable evidence IDs. The `implant.portfwd`, `implant.rportfwd`, and
`implant.socks5` families are planned under M5.

Result: the pinned Ghostty 0.4.0 runtime and digest verified; **261 static
command nodes regenerated and 261 reviewed annotations validated**, with the
dynamic alias/extension audit passing. The full protocol lane also reproduced
five generated protobuf files, six handwritten wrapper-overlay files, and the
vendored wrapper bundle under the locked Node 24.0.0 runtime.

The final package and opt-in real-session lane were:

```sh
npm run package

SLIVER_GUI_M3_REAL_E2E=1 \
SLIVER_GUI_E2E_CONFIG=/absolute/path/operator.cfg \
SLIVER_GUI_E2E_SESSION_ID=<exact-session-id> \
SLIVER_GUI_PACKAGED_EXECUTABLE=/absolute/path/to/Sliver\ GUI \
npm run test:e2e:packaged-real-m3
```

The harness realpaths the selected executable, derives its exact adjacent
`resources/app.asar`, and runs the production-content verifier against that
archive before launch. The final macOS arm64 package evidence was:

- `app.asar`: 15,228,926 bytes, SHA-256
  `7f4e80ad525e0926d38bc4c70f5c80af4538e9c583ce00c7900ef1590e13b4ed`.
- executable: 33,968 bytes, SHA-256
  `34465676648bf5e5892e8f7791929be7ee01973a5317260f4f741ab7110cfef6`.

Result: **2 tests passed, zero failed, zero skipped** in 6.90 seconds against
one exact pre-authorized darwin/arm64 session over a literal-loopback mTLS
operator connection. The journey proved normal input/output, resize request,
detach/reattach, reviewed Close, exact child-PID disappearance, empty managed
resource/queue accounting, unchanged baseline session identity, and isolated
temporary-data cleanup. A live run exposed and drove the remote-EOF close
barrier; the settled rerun began and ended with no direct shell child.

## Operator acceptance checklist

Use only an authorized disposable session and an operator configuration whose
cleanup scope is understood.

1. Open one live session, select **Shell**, and start a new shell.
2. Confirm normal keyboard input/output and explicit focus, Copy, and Paste.
3. On Linux or macOS, resize the workspace and confirm the UI continues to say
   the PTY and resize are requested or unconfirmed. On Windows, confirm resize
   is unavailable.
4. Detach, verify the terminal surface disappears, then select the shell in the
   **Shells** inventory and confirm it attaches immediately and remains usable.
5. Choose **Pop out managed shells**. Confirm the same shell opens in the
   dedicated window without starting another remote process, accepts input,
   and re-docks when that window closes.
6. Verify multiline/control-character paste requires confirmation without
   displaying the payload in the review.
7. Review Close and Kill independently. Treat Close as local closure plus a
   best-effort remote request, not proof of remote process termination.
8. Confirm no shell content appears in Activity, broad snapshots, diagnostics,
   or metrics.
9. Use the **Sessions** breadcrumb dropdown to switch to another live session.
   Confirm the selected session and route change together, and confirm a
   workspace with managed shells requires the warning and explicit approval.
10. From a session and from a beacon, choose **Pop out interaction**. Confirm
    each native window opens on the exact target with the complete dedicated
    interaction surface, no generic application chrome, and no recursive
    interaction-popout control.
11. Confirm existing managed shells remain owned by the source window, the
    interaction window maintains independent operation/task state, and
    reloading it restores the same exact authorized target without exposing a
    target identifier in the URL.
12. Record the explicit acceptance decision. The operator accepted this
    delivered session-shell scope and authorized M4 on 2026-08-15.

## Deferred evidence and parity

- The opt-in packaged real-session lane is now complete for the current macOS
  arm64 package, literal-loopback mTLS operator transport, and one authorized
  darwin/arm64 session. It creates no implant or session and performs no
  wildcard cleanup; failure cleanup can invoke Kill only through the exact
  main-owned managed resource.
- Installed-package and real-session evidence on Windows and Linux
  operator/target combinations remains pending.
- WireGuard operator transport and its packaged helper remain deferred. Current
  evidence does not claim WireGuard shell coverage.
- There is no upstream beacon-shell command to implement or certify in this
  baseline.
- Forwarding, reverse forwarding, SOCKS, remote persistent-resource
  reconciliation, and later browser-debug tunnels remain M5 or later work.
