# Remote Desktop

Remote Desktop is a standalone RDP client inside Sliver GUI. It connects directly
from this machine to a Windows RDP server over TCP with TLS. Network Level
Authentication (NLA) is the default. No Sliver server, operator configuration or implant is needed.
The bundled native IronRDP engine presents the desktop in the sandboxed React
renderer. See the [architecture and acceptance status](rdp-client-design.md).

## Connect

1. Open **Network → Remote Desktop** (also available under **File** or by searching
   **RDP** in the command palette), then **New connection**.
2. Enter a bare hostname/IP, port (normally 3389), Windows username and optional
   domain. Enter the password and choose a desktop resolution, or select **Custom**
   to enter width and height. Invalid fields show an inline explanation; correct
   them before connecting or saving a profile. Saving a profile does not require
   a password.
3. Choose whether to remember the password. **Clipboard** is enabled by
   default. Changing it saves your preference immediately for new connections,
   including when you cancel the dialog; saved profiles retain their own choice.
   **Save profile** stores connection preferences separately from the password.
   Remembering a password on a new connection creates a profile.
4. Select **Connect**. If certificate review is required, compare the displayed
   SHA-256 fingerprint with the administrator's expected value. **Trust once**
   applies to this attempt; **Trust and remember** pins that hostname/port to the
   certificate. Cryptographic failures cannot be overridden.
5. Click the desktop to control it. **Ctrl+Alt+Escape** releases keyboard capture.
   Toolbar buttons send the Windows key or Ctrl+Alt+Delete explicitly.

To enter credentials in Windows instead, enable **Sign in on the remote screen**
before connecting. The username, domain, password and password-storage controls
are hidden, and the client opens the Windows sign-in screen without sending
account credentials during connection setup. Enter your account details there;
use the toolbar's **Send Ctrl+Alt+Delete** button if Windows requests it.
The server must allow connections without NLA. If it requires NLA, the attempt
fails with an explanation; the client never changes server policy or automatically
downgrades an NLA connection. TLS encryption and certificate review apply in both
modes. Saved profiles remember the selected sign-in mode, and remote-screen
profiles reconnect without a local password prompt.

Hostnames, IPv4 and bare IPv6 addresses are supported; put the port in its separate
field. The default mode requires a compatible password-based NLA account and server
policy. Legacy Standard RDP Security, Kerberos/SSO and RD Gateway are not offered.
Certificate review expires after 60 seconds; cancel or review again after reconnect.

## Connect from Overview

Right-click a live Windows session in **Overview** and select **RDP**. The app
opens a temporary forward on `127.0.0.1` using an OS-assigned local port, through
that exact Sliver session to `127.0.0.1:3389` on the remote machine. The RDP
credentials dialog opens with that local endpoint filled in. Enter a Windows
account and password, or enable **Sign in on the remote screen**, then select
**Connect**. Windows beacons show the action
disabled until an interactive session is available; non-Windows machines omit it.

The endpoint is read-only. Temporary connections do not save profiles, passwords,
previews or certificate pins; certificate review offers **Trust once**. Canceling
the dialog, disconnecting, closing the tab/window, reloading the viewer, losing
the source session/backend, or quitting the app removes the forward. To connect
again, select **RDP** from Overview again. Other RDP sessions retain their normal
lifecycle.

## Desktop controls and lifecycle

- **Fit** scales the remote image to the window; **Actual size** uses its natural
  pixel dimensions. These choices are local to the current tab.
- **Configuration** requests a window-sized desktop, optionally on later window
  resizes. With **Resize desktop with window** enabled, turn on **Scale desktop
  for high-DPI displays** to request more desktop pixels and matching Windows
  text/icon scaling for the current display. It starts off; changing it applies
  immediately while automatic resizing is enabled. These display choices are
  local to this window and are not saved. Repeated requests for the same size are ignored.
  High-DPI Windows scaling requires live display-control support. If the server
  cannot resize live, the connection stops with a size-specific explanation;
  disable **Resize desktop with window**, then use **Reconnect** to apply the
  remembered resolution. This fallback preserves the resolution only, not Windows
  text/icon scaling. The client does not reconnect automatically. The picture
  keeps its actual server geometry until it changes.
- The toolbar's upload and download icons have **Send clipboard** and
  **Receive clipboard** tooltips. Copy text or files locally, select Send, then
  paste remotely with Ctrl+V. To copy from the remote desktop, copy text or files
  there with Ctrl+C and select Receive; after it completes, paste into a local
  application or folder. These actions need the focused active RDP window and a
  connection started with Clipboard enabled. Receive becomes available when the
  server advertises text or files. Files take priority when both are available.
  Text is limited to 1 MiB UTF-8. File transfers support up to 64 regular files
  totaling at most 256 MiB; folders and symbolic links are not supported.
  Received files are downloaded into private temporary storage before the local
  clipboard is updated. Paste them locally before quitting the app; quitting
  removes the staged files. Across received clipboard copies, the app retains up
  to 1 GiB or 1,024 files. Another receive fails if it would exceed either total;
  paste the files you need locally, then quit and reopen the app to clear storage.
  After sending local content, copy remotely again to enable Receive. A clipboard
  failure leaves the desktop connected; copy the content again before retrying.
- **Configuration → Transparent clipboard** automatically sends changed local
  text or files and receives copied remote content while the RDP window is focused
  and its active connection has Clipboard enabled. It is disabled by default, and
  changing it saves the preference for future RDP windows. Turning it off returns
  clipboard transfer to the manual toolbar buttons. The same transfer limits apply.
  Clipboard contents are not stored in settings.
- Clipboard confirmations, action failures and active-session warnings appear as
  toast notifications without moving or resizing the remote desktop. Repeated
  updates for the same session warning do not show it again after dismissal.
  File transfers show a progress bar with bytes and file counts, followed by their
  completion, failure or cancellation in the same toast. Sending files starts
  transferring when the remote desktop requests them after Paste. Dismissing a
  progress toast leaves the transfer running and keeps that notification dismissed.
- **Disconnect** ends RDP without logging the Windows account off. **Reconnect**
  starts a new attempt and asks for a password when none was remembered. Closing
  a tab disconnects it; up to four tabs may be open, including disconnected tabs.
- Closing the RDP window preserves direct live connections until the app quits. Reopen
  it through File → Remote Desktop; select **Reattach viewer** if prompted.
  Renderer reload normally reattaches automatically. Pending certificate review
  is canceled when its viewer closes. App quit ends every connection.

Saved connections appear as desktop preview cards in the empty window and the
folder button's **Saved Connections** picker. Each card shows the connection name
and account, with the last saved desktop frame behind it. Connections without a
saved frame show **No preview yet**. Select a card to connect using its saved
settings and remembered password. If no password is remembered, a compact prompt
asks for the password and whether to remember it.

Right-click a card for **Connect**, **Edit**, or **Delete**. Choose **Edit**, change
the connection settings, then select **Save profile** to save them. The card's
trash button also deletes the connection after confirmation.

For saved connections, the viewer saves the first complete frame, refreshes the
preview every 15 seconds when the desktop changes, and saves the latest complete
frame when disconnecting or closing its tab. Previews survive closing the app.
Changing the computer, port, username, domain or sign-in mode clears
the old preview; deleting a profile removes its preview and remembered credential.
Endpoint certificate pins are independent of profiles; deleting a profile does
not erase its pin. A pin-management UI is not yet available. There is no automatic
reconnect.

## Password storage

**Do not save** keeps no reconnect credential. **Until the app quits** stores it
only in main-process memory. **Save securely on this device** uses Electron's OS
secure-storage backend; it is disabled when encryption is unavailable, including
Linux `basic_text`/unknown backends. Existing credentials are never filled back into
the form. A blank password on an existing saved profile requests its stored
credential; a locked/unavailable backend asks for fresh input.

Remote-screen sign-in does not use or remember an RDP password. Saving an existing
profile in this mode removes its remembered credential. Credentials typed into
Windows travel as keyboard input inside the encrypted RDP connection.

The default clipboard and transparent clipboard preferences use the existing
application settings store, `gui/application-settings.json`, under the configured
Sliver GUI client root.
Clipboard contents are never saved in this file.

The RDP-specific private file is `gui/rdp.json` under the configured Sliver GUI
client root. It contains profile metadata, endpoint pins and encrypted credential
envelopes, never plaintext passwords. Failed persistence does not replace/delete
previously stored credentials. Clipboard data and desktop images are not saved
in that settings file. Preview images are stored separately in private
`gui/rdp.json.preview-*.json` files alongside it. These local thumbnails may contain
visible desktop information and are not encrypted with the password vault.
If Remote Desktop reports that its settings cannot be loaded safely, stop
the app and repair the file permissions or restore a known valid private backup.
The core GUI remains available; RDP does not silently reset its trust store. Do
not edit this file while the application is running.

## Current limits

The client implements one monitor, password NLA or explicit TLS remote-screen sign-in, cursor/mouse/keyboard/Unicode,
local scaling, fullscreen, server resize, manual text/file clipboard transfer and
optional automatic clipboard synchronization. Display
requests are 200–8192 pixels per axis with at most 16,777,216 pixels total.
File clipboard requires server file-transfer support and compatible local file
clipboard formats. Live GOAD tests verify macOS native file clipboard transfers
to Windows Explorer and back, including byte hashes and progress toasts; see
[file-transfer acceptance](rdp-file-transfer-acceptance.md). Windows and Linux
local clients and pasting received files through Finder's UI remain unverified.
Audio/microphone, multiple monitors, RemoteApp,
device/drive/printer redirection, smart cards, UDP, `.rdp` import and advanced multimedia codecs are
outside the current feature set. Overview connections use a main-owned loopback
TCP forward; the native helper connects to that listener. Arbitrary supplied
streams and custom native transports are not implemented.

Package targets match the GUI: macOS universal (Intel and Apple Silicon), Windows
x64 and Linux x64. A complete live-GUI scenario passed on macOS 27.0.1 arm64;
the final rebuilt helper passed locally, while the other installed/minimum-OS
targets remain pending. Consult the design's evidence section before making a support claim.

## Developer build and checks

Follow the repository [setup requirements](../README.md). Install the pinned RDP
Rust toolchain/targets, then build the local helper:

```sh
npm run setup:rdp
npm run build:rdp:host
npm run build
npm run test:rdp:native
npm run test:rdp:build
npm run test:rdp:loader
```

`npm run dev` builds the host helper automatically. Packaging uses `npm run
build:rdp`, which builds both macOS slices on macOS and verifies provenance/ABI.
Generated helper files are under `native/rdp/bin/` and are not committed. Windows
requires the MSVC build environment; Linux release builds must meet the pinned
glibc baseline. The runtime is packaged outside ASAR, and its integrity/protocol
checks run before credentials or a network connection are supplied.

## Opt-in Windows interoperability test

Use an explicitly authorized disposable Windows desktop with NLA, text clipboard
allowed, and an account permitted to log on by RDP. Run one test client at a time
for that interactive account. The current scenario expects a certificate that
requires review, compares an exact independently verified fingerprint, launches
Notepad, sends keyboard text, round-trips Unicode clipboard text, reloads the
viewer and disconnects. A normally PKI-trusted server that produces no review
needs a separate test scenario.

Create a private JSON file **outside the repository**, replacing every placeholder
below. On macOS/Linux use permissions `0600`; on Windows restrict the file's ACL
to the test account. Do not put the password in shell arguments or commit the file.
The fingerprint is the server certificate's SHA-256 hex digest without colons.

```json
{
  "host": "windows-test.example.invalid",
  "port": 3389,
  "username": "rdp-test-user",
  "domain": "TESTLAB",
  "password": "REPLACE_WITH_DISPOSABLE_ACCOUNT_PASSWORD",
  "label": "Disposable Windows desktop",
  "width": 1280,
  "height": 800,
  "clipboard": true,
  "scaleMode": "fit",
  "persistence": "none",
  "fingerprint": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Point the environment variable at that file; only the path belongs in the command:

```sh
SLIVER_RDP_E2E_CONFIG_FILE=/absolute/private/rdp-test.json npm run test:e2e:rdp-live
```

In PowerShell, set `$env:SLIVER_RDP_E2E_CONFIG_FILE` to the absolute private JSON
path, then run the same npm script. Run the GUI test in an interactive desktop
session so the RDP window can obtain operating-system focus.

Without the variable, the live test is skipped. Use `clipboard: true` for this
scenario. The runner uses temporary application state and restores the previous
local clipboard during cleanup. It may alter the disposable user's interactive
desktop; review cleanup after an interrupted run.

Successful runs produce `artifacts/e2e/rdp-live-desktop.png` and
`artifacts/e2e/rdp-live-result.json`; failures can produce `rdp-live-failure.png`.
These ignored screenshots may contain remote desktop information. Keep them with
private test evidence rather than committing them. The result file must come from
a terminal successful run and be paired with GUI/helper revisions and exact
client/server versions; its existence from an older run is not current evidence.

For remote-screen sign-in, use the same private account configuration with
`"scenario": "login"` and a server that explicitly allows non-NLA connections:

```sh
SLIVER_RDP_REMOTE_SCREEN_E2E_CONFIG_FILE=/absolute/private/rdp-test.json \
SLIVER_RDP_REMOTE_SCREEN_E2E_ARTIFACT_PREFIX=rdp-remote-screen-disposable \
npm run test:e2e:rdp-remote-screen-live
```

The test enables the option through the connection dialog, verifies that initial
account fields are absent, reviews the certificate, captures the Windows login
screen before entering credentials, then verifies desktop keyboard input and a
Unicode clipboard round-trip. Credentials in the private test configuration are
used only by the test driver to type into Windows. The default login sequence is
Ctrl+Alt+Delete, username, Tab, password, Enter. The private configuration may set
`loginUsername` or bounded `loginSteps` for a different Windows login layout; see
the [test source](../src/e2e/rdp-remote-screen-live.e2e.ts).

Use `"scenario": "nla-required"` against a server that requires NLA to check the
explicit rejection without sending credentials. The harness does not change
server policy. Restore any authorized temporary lab-policy changes separately.
The existing NLA test accepts `SLIVER_RDP_E2E_ARTIFACT_PREFIX` for separate evidence
per host. See [GOAD sign-in acceptance](rdp-sign-in-acceptance.md) for measured results.

For file interoperability, the SSH alias must reach the same disposable Windows
host, with public-key access and permission to create a temporary test directory
and a temporary scheduled task in the RDP user's existing interactive session.
The file scenario stages its helper over SSH, pastes an 8 MiB binary, Unicode-named
text file and empty file into Windows Explorer through RDP, verifies SHA-256 over
SSH, and receives those files through the native local clipboard. It checks byte
progress and toast outcomes in both directions, restores the local clipboard and
removes its test files and Explorer window.
Filename comparisons account for macOS Unicode normalization; file contents must
match exactly. The helper runs only in the configured account's existing active
RDP session, and its temporary scheduled tasks are removed during cleanup.

```sh
SLIVER_RDP_E2E_CONFIG_FILE=/absolute/private/rdp-test.json \
SLIVER_RDP_E2E_SSH_HOST=disposable-windows \
SLIVER_RDP_FILES_E2E_ARTIFACT_PREFIX=rdp-files-disposable \
npm run test:e2e:rdp-files-live
```

Set `SLIVER_RDP_E2E_TRANSPARENT=1` to exercise Transparent clipboard instead of
the manual Send/Receive buttons. Choose a distinct artifact prefix per host and
mode. Results and screenshots are written under ignored `artifacts/e2e/` paths.
The test brings its RDP window to the foreground; keep it focused while it runs.

Recorded final live-GUI result: **PASS, 2026-10-20T02:08:43.278Z**, macOS 27.0.1
arm64, Electron 44.5.1, Windows Server 2019, fork
`1835457f27045d0098a4861b7b50204539539ec6`. NLA, rendering, keyboard text readback,
Unicode clipboard round-trip, renderer reattachment and disconnect passed with
helper SHA-256 `67360927081daaef040a0908d9cd6a190d70313919fc8bf3734a894660f807eb`.
Other client OS/minimum-runtime installed checks remain pending.
