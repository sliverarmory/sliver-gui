# Script Editor

Open **Automations → Script Editor** to create, edit, save and run local JavaScript.
It works without a server connection. A new library contains an editable **Hello
World** script. Opening or saving a script never runs it.

Use **Save** (`Cmd/Ctrl+S`) to persist changes. **Run** (`Cmd/Ctrl+Enter`) executes
a snapshot of the current editor contents, including unsaved changes. **Stop**
terminates the run. Switching scripts or leaving the view also stops execution.
Drafts and editor undo/view state remain in the current window across page
navigation. Closing or quitting with unsaved drafts offers Keep Editing or
Discard Changes. The output toolbar identifies the run's script and whether the
source has changed since that run. Output is bounded, in-memory, and can be
copied or cleared.

Use **Export…** in Script actions to save the current editor contents, including
unsaved edits, to a `.js` file through the native Save As dialog. Export leaves
the library copy and its unsaved status unchanged. Main sanitizes the suggested
basename before showing the dialog; the renderer cannot supply a destination
path.

Use **Import script** next to New to choose a `.js` file. Main validates its size
and UTF-8 contents, then creates a new UUID-backed library copy and selects it.
Import never runs the file and never modifies the original file on disk.

## JavaScript capabilities

The initial host capability surface is exactly:

```javascript
console.log("Hello, world!");
console.info("Answer: %d", 42);
console.debug({ enabled: true });
console.warn("A warning");
console.error(new Error("An example error"));
```

Console methods support multiple arguments and common `%s`, `%d`, `%i`, `%f`,
`%o`, `%O`, `%j`, and `%%` formatting. Inspection is deliberately bounded.
Getters and custom `toJSON`/inspection hooks are not invoked. Cycles, accessors,
deep/large values and uninspectable objects receive readable placeholders.
`%j` uses descriptor-only JSON with placeholders and quoted BigInt values, so it
is a safe subset of Node's formatting rather than an exact `util.inspect` clone.

Standard JavaScript objects and promise microtasks are available. Jobs are
pumped in bounded batches. A rejected completion promise reports an error;
a pending completion promise reports that it cannot finish without external
I/O. Detached rejected promises are not tracked by the current QuickJS wrapper.
There is no Node event loop, timer API, module/package import, network,
filesystem, process, browser DOM, Electron API, or Sliver capability.

## Execution boundary

Only trusted bundled code runs in the application's browser realm and worker.
Source text is sent as data to `context.evalCode` inside QuickJS WebAssembly.
It is never used with host `eval`, `Function`, script elements, Blob workers,
dynamic imports, or a native Node VM. Each run gets a new dedicated worker,
WASM memory, runtime, and context. Completion, failure, Stop, navigation and
timeouts discard the worker. Guest code cannot obtain the worker's host global.

The sole host callback accepts an allowlisted console severity and a bounded
primitive string. Guest objects are inspected inside QuickJS, under the same
execution limits. Worker messages have validated run IDs, ordered sequences,
batch limits and an output budget; old run messages are ignored. No generic
host-object bridge or method dispatcher is available to the guest.

| Limit | Value |
| --- | --- |
| Source | 512 KiB of valid UTF-8 |
| Execution | 5 seconds; separate 15-second worker initialization deadline |
| QuickJS allocations | 64 MiB |
| Guest stack | 512 KiB |
| WASM linear memory | 128 MiB maximum, verified imported memory |
| Output | 1 MiB or 4,096 records, whichever comes first |
| Individual record | 16 KiB |

An independent renderer watchdog terminates the worker even if a QuickJS
builtin does not promptly reach an interrupt check. These bounds do not claim
a total Electron process memory ceiling. Interpreter teardown failures after
out-of-memory are contained by discarding the entire worker, never reusing it.

Output is text. Guest control characters, including terminal escape sequences,
are escaped before application-owned severity colors/newlines are added.
The existing Ghostty sanitizer remains in the path. The terminal has no input
destination or shell/PTY and exposes no guest-controlled clipboard, title,
hyperlink, or application callback.

## Storage

Main owns `~/.sliver-client/gui/scripts/` (or `gui/scripts/` beneath the existing
`SLIVER_CLIENT_ROOT_DIR` override). It generates canonical UUID v4 IDs and writes
`<UUID>.js` plus a versioned `names.json` mapping IDs to display names. Names are
metadata only and never participate in filesystem paths. The renderer supplies
neither filenames nor paths. Saved source is never served by `sliver://app`.

The shared store serializes mutations, validates private regular files, rejects
symlinks in its owned directories, and uses private atomic writes. Revisions
cover both source and name; stale saves are rejected while retaining the draft.
The library is limited to 1,000 scripts. Orphan sources are visible for recovery;
missing sources are reported. Corrupt metadata is preserved and must be repaired
before further writes. Source and metadata commits are separately atomic, not
a two-file transaction or a promise of durable recovery from all power failures.

## Monaco integration and packaging

`CodeEditor` is independent of storage and execution. Its controlled document,
model identity, language/profile, readonly state, theme, accessible name, and
Save/Run callbacks can be reused by other views. The scripting profile runs a
separate local TypeScript analysis worker with ES2023 and the console allowlist,
without browser/Node types. Cached scripts have independent analysis scopes.

All editor/interpreter code and workers ship locally. QuickJS WASM is loaded
through a fixed, hash-verified main-process asset endpoint; no runtime fetch is
needed. `protocol/script-editor-provenance.json` pins package integrities and the
interpreter digest. Packaging checks require the WASM, workers, and licenses.

Monaco's trusted stylesheet/markup emitters are adapted at build time to CSSOM.
The adapter verifies exact upstream source hashes and fails on an unreviewed
upgrade. CSP adds only the SHA-256 of an empty stylesheet for Monaco's empty
style handles. Their rules live in constructed stylesheets, adopted into the
owning document or shadow root only while each handle is connected. A shared
observer with weak references preserves detached-widget reuse without retaining
disposed widgets. Nonempty inline styles, script
attributes, ordinary JavaScript eval, external connections, Blob workers, and
Node integration remain blocked. User source remains escaped editor text.

## Verification

```sh
npm run typecheck
npm test
npm run test:e2e:scripts
```

The Electron test uses the actual Monaco editor, analysis worker, QuickJS WASM
worker and Ghostty canvas under production CSP and Chromium sandboxing. It
exercises persistence, UUID/name separation, editing/running unsaved buffers,
resource limits, capability absence, inert output, cancellation, recovery,
cross-window conflicts and navigation. It also sweeps window/divider sizes to
detect scrollbar layout loops while retaining Monaco's content scrolling, and
exports/imports an unsaved buffer through real IPC with native file selections
stubbed to temporary files. Its data root is a temporary directory;
it starts no Sliver connection or remote operation.

After packaging, the same test can target the packaged executable by setting
`SCRIPT_EDITOR_PACKAGED_EXECUTABLE` and running the compiled
`.e2e-dist/src/e2e/script-editor.e2e.js` with `node --test`.
