# RDP file clipboard acceptance

Live GOAD verification on 2026-10-21 UTC, 04:37:08–04:41:49. **7 of 7 cases passed, covering 14 directional transfers.**

| Host | Windows Server / build | Mode | Result | Evidence |
| --- | --- | --- | --- | --- |
| KINGSLANDING · 10.13.37.10 | 2019 / 17763 | Manual | PASS | [Result](../artifacts/e2e/rdp-files-kingslanding-manual-result.json) |
| WINTERFELL · 10.13.37.11 | 2019 / 17763 | Manual | PASS | [Result](../artifacts/e2e/rdp-files-winterfell-manual-result.json) |
| MEEREEN · 10.13.37.12 | 2016 / 14393 | Manual | PASS | [Result](../artifacts/e2e/rdp-files-meereen-manual-result.json) |
| CASTELBLACK · 10.13.37.22 | 2019 / 17763 | Manual | PASS | [Result](../artifacts/e2e/rdp-files-castelblack-manual-result.json) |
| BRAAVOS · 10.13.37.23 | 2016 / 14393 | Manual | PASS | [Result](../artifacts/e2e/rdp-files-braavos-manual-result.json) |
| CASTELBLACK · 10.13.37.22 | 2019 / 17763 | Transparent | PASS | [Result](../artifacts/e2e/rdp-files-castelblack-transparent-result.json) |
| MEEREEN · 10.13.37.12 | 2016 / 14393 | Transparent | PASS | [Result](../artifacts/e2e/rdp-files-meereen-transparent-result.json) |

Each passing case copies three regular files into Windows Explorer through RDP, then receives those files through the local native clipboard: an 8,388,608-byte binary, a 43-byte Unicode text file named `clipboard-café-日本語.txt`, and an empty file. SHA-256 and byte counts match at the source, Windows destination, and received local staging paths; each direction transfers 8,388,651 bytes. Filename comparisons use Unicode NFC canonical equivalence because macOS can expose decomposed names. Original remote and received names remain in each result; the test does not rename files.

Passing results include intermediate byte progress in both directions, recorded DOM updates for sending/receiving and completion toasts, all three completed files, restored original clipboard formats, removed local staging, and removed owned remote test files. The upload and received PNGs beside each result show **completion** toasts and the Windows Explorer destination; they do not show a mid-transfer progress bar. The separate offline renderer/Electron checks cover progress-bar layout.

The client is macOS (`darwin`) arm64, kernel `27.0.0`, Electron `44.5.1`. Native helper SHA-256: `f4d996eeeb482e97bb9f49ab0867b41bb0b78b49e62a3932b4008d3771df7760`; IronRDP revision: `bfa5a8966fce80d659765c018895036ec775a012`; build identity: `98804b880bdd28e85ec6e3f2e334f84a613a39e128e992cd72d7baa38f1534cb`. Endpoint certificates are checked against exact configured fingerprints. Windows versions and policy observations are recorded in the [environment evidence](../artifacts/e2e/rdp-files-goad-environment.json).

The opt-in [live harness](../src/e2e/rdp-files-live.e2e.ts) uses a private RDP configuration and a management SSH host alias. SSH stages the interactive helper and checks hashes; fixture bytes travel through RDP. Unique scheduled tasks use the existing interactive account token and verify the intended RDP session before clipboard actions. Task definitions, the owned Explorer window, and test files are cleaned up. Result JSON is published only after cleanup succeeds. Generated evidence remains under `artifacts/e2e/` and is not committed.

A separate [final cleanup audit](../artifacts/e2e/rdp-files-goad-cleanup.json) confirmed zero test directories and scheduled tasks on all five hosts. The pre-existing Robb Stark sessions on Winterfell and Castelblack remained active. Temporary local test credentials and SSH helpers were removed after verification.

Live **local Windows and Linux clients remain untested**. The local macOS check verifies native clipboard file URLs and their staged bytes; **pasting those files through Finder's UI remains untested**. These results do not cover folder copies, symbolic links, or transfers at the configured size/count limits.
