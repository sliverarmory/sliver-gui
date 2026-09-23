# Standalone Text Editor

Choose **File → New Text Editor** to open a separate native window. **Open…**
selects a local file. The editor accepts UTF-8 text up to 2 MiB and rejects
binary control bytes, invalid UTF-8, directories, and larger files. File type
validation uses the contents; a `.txt` extension alone does not make a file
editable. UTF-16 and other encodings are not supported.

The toolbar provides Save, Save As, Undo, Redo, Find, Replace, Word Wrap, the
Monaco command palette, font size, and syntax highlighting. The minimap is
enabled by default. The language selector includes Bash highlighting, and
`.sh`, `.bash`, `.zsh`, `.bashrc`, `.bash_profile`, `.bash_login`, and `.profile`
files select it automatically. Highlighting never executes the document.

Choose **Commands** or press F1 to find and run the Monaco commands bundled with
the application. Every editor button has a keyboard shortcut, shown in its
tooltip and exposed to assistive technology. Configure the Text Editor shortcut
group in application Settings; defaults include Command/Control+O for Open,
Command/Control+S for Save, Command/Control+Shift+S for Save As, and Alt+Z for
Word Wrap. The footer shows cursor position, character count, encoding, and line
endings.

The compact editor header also serves as the drag region. On macOS it reserves
space beside the native window controls instead of placing a separate empty
titlebar row above the document.

Open and close prompt before discarding unsaved changes. Cancelling a picker or
failed save preserves the draft. Typing during a save keeps later edits marked
unsaved. Opening another file temporarily makes the current editor read-only.
Writes use a temporary file and rename, preserving an existing UTF-8 BOM and
consistent line endings. New files default to UTF-8 without a BOM.

In a session's File Browser, choose **Edit text…** from a file's action menu
to download the complete remote file into a standalone editor. Remote editing
accepts UTF-8 text up to 64 KiB. Save stages the edited bytes and shows an
overwrite confirmation with the session, path, and file digests. Canceling
keeps the draft unsaved. A confirmed save checks the remote file's original
SHA-256 again before upload and rejects a changed file. The upstream upload is
not atomic, so another remote writer can still race after this check. Remote
documents do not offer local Open or Save As actions.

## Reuse

The implementation has three layers:

- `src/renderer/src/components/CodeEditor.tsx` owns Monaco models, undo history,
  editor commands, cursor events, layout, and locally bundled highlighting.
- `src/renderer/src/components/TextEditorWorkspace.tsx` provides document UI,
  dirty tracking, controls, and asynchronous save handling. Its callbacks have
  no Electron or filesystem dependency. Mount it with `key={document.id}` when
  replacing a document; save callbacks return a title on success or `null` on
  cancellation, and throw on failure.
- `src/main/text-editor-windows.ts` owns native windows and local file access.
  `TextEditorWindows.open({ title, text, language, readOnly })` opens an optional
  initial text buffer. `openRemote` accepts a main-owned binding to the exact
  source session. `TextEditorWindowApp.tsx` connects its dedicated preload to
  the reusable workspace.

Only Electron main holds local paths. Each window has a sandboxed preload with
fixed editor methods and a separate session partition. IPC validates the owning
window and its current main frame. The editor has no operator, session, network,
or script execution bridge. The remote editor uses narrow main-process
callbacks bound to the source session and existing reviewed file action path.
Application shutdown checks editor close guards before stopping services.

## Validation

Run `npm run typecheck` and the editor Vitest tests for save races, cancellation,
validation, IPC ownership, native close handling, and Monaco model cleanup.
`npm run test:e2e:text-editor` exercises real Monaco and native Electron windows
offline, including file round trips, Bash detection and tokenization, the
default minimap, the command palette, compact header layout, controls, close
prompts, and strict CSP.
