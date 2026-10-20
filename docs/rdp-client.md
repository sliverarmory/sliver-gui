# Remote Desktop

Remote Desktop is a standalone RDP client inside Sliver GUI. It connects directly
from this machine to a Windows RDP server over TCP with TLS and Network Level
Authentication (NLA). No Sliver server, operator configuration or implant is needed.
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
3. Choose whether to remember the password. **Text clipboard** is enabled by
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

Hostnames, IPv4 and bare IPv6 addresses are supported; put the port in its separate
field. Authentication requires a compatible password-based NLA account and server
policy. Legacy non-NLA security, Kerberos/SSO and RD Gateway are not offered.
Certificate review expires after 60 seconds; cancel or review again after reconnect.

## Desktop controls and lifecycle

- **Fit** scales the remote image to the window; **Actual size** uses its natural
  pixel dimensions. These choices are local to the current tab.
- **Display settings** requests a window-sized desktop, optionally on later window
  resizes. Repeated requests for the same size are ignored. If the server cannot
  resize live, the connection stops with a size-specific explanation; use
  **Reconnect** to apply the remembered dimensions. The client does not reconnect
  automatically. The picture keeps its actual server geometry until it changes.
- **Send clipboard text** copies local text into the remote clipboard. Paste it
  remotely with Ctrl+V. Copy text remotely with Ctrl+C, then select **Receive
  clipboard** to replace the local clipboard. These actions need the focused
  active RDP window and a connection started with Text clipboard enabled. Receive
  becomes available only when the server advertises text. Limit: 1 MiB UTF-8.
  After sending local text, copy remotely again to enable Receive. A clipboard
  failure leaves the desktop connected; copy the text again before retrying.
- **Disconnect** ends RDP without logging the Windows account off. **Reconnect**
  starts a new attempt and asks for a password when none was remembered. Closing
  a tab disconnects it; up to four tabs may be open, including disconnected tabs.
- Closing the RDP window preserves live connections until the app quits. Reopen
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
Changing the computer, port, username or domain clears
the old preview; deleting a profile removes its preview and remembered credential.
Endpoint certificate pins are independent of profiles; deleting a profile does
not erase its pin. A pin-management UI is not yet available. There is no automatic
reconnect or automatic clipboard synchronization.

## Password storage

**Do not save** keeps no reconnect credential. **Until the app quits** stores it
only in main-process memory. **Save securely on this device** uses Electron's OS
secure-storage backend; it is disabled when encryption is unavailable, including
Linux `basic_text`/unknown backends. Existing credentials are never filled back into
the form. A blank password on an existing saved profile requests its stored
credential; a locked/unavailable backend asks for fresh input.

The default text clipboard preference uses the existing application settings store,
`gui/application-settings.json`, under the configured Sliver GUI client root.
Clipboard contents are never saved in this file.

The RDP-specific private file is `gui/rdp.json` under the configured Sliver GUI
client root. It contains profile metadata, endpoint pins and encrypted credential
envelopes, never plaintext passwords. Failed persistence does not replace/delete
previously stored credentials. Clipboard text and desktop contents are not saved
in that settings file. Preview images are stored separately in private
`gui/rdp.json.preview-*.json` files alongside it. These local thumbnails may contain
visible desktop information and are not encrypted with the password vault.
If Remote Desktop reports that its settings cannot be loaded safely, stop
the app and repair the file permissions or restore a known valid private backup.
The core GUI remains available; RDP does not silently reset its trust store. Do
not edit this file while the application is running.

## Current limits

The client implements one monitor, password NLA, cursor/mouse/keyboard/Unicode,
local scaling, fullscreen, server resize and explicit text clipboard. Display
requests are 200–8192 pixels per axis with at most 16,777,216 pixels total.
File clipboard, audio/microphone, multiple monitors, RemoteApp, device/drive/printer
redirection, smart cards, UDP, `.rdp` import and advanced multimedia codecs are
outside the current feature set. Supplied networking/Sliver routes require a future
typed native transport integration; the current client always uses direct TCP.

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

Recorded final live-GUI result: **PASS, 2026-10-20T02:08:43.278Z**, macOS 27.0.1
arm64, Electron 44.5.1, Windows Server 2019, fork
`1835457f27045d0098a4861b7b50204539539ec6`. NLA, rendering, keyboard text readback,
Unicode clipboard round-trip, renderer reattachment and disconnect passed with
helper SHA-256 `67360927081daaef040a0908d9cd6a190d70313919fc8bf3734a894660f807eb`.
Other client OS/minimum-runtime installed checks remain pending.
