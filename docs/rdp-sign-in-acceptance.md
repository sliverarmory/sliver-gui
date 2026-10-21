# RDP sign-in acceptance

Live verification on 2026-10-20 PDT / 2026-10-21 UTC used the macOS 27.0.1 arm64
client with Electron 44.5.1 and the native helper rebuilt from the working tree
based on GUI commit `41933587a613cd7e4e4cd56b789e8d46829a6316`.

| GOAD host | Windows version | Scenario | Result |
| --- | --- | --- | --- |
| kingslanding | Server 2019, build 17763 | Remote-screen mode with NLA required | Explicit rejection before credentials or desktop frames |
| meereen | Server 2016, build 14393 | Remote-screen mode with NLA required | Explicit rejection before credentials or desktop frames |
| kingslanding | Server 2019, build 17763 | Remote-screen mode with NLA temporarily optional | Windows login screen, sign-in, keyboard input, Unicode clipboard round-trip and disconnect passed |
| kingslanding | Server 2019, build 17763 | Default NLA after policy restoration | Login, desktop, keyboard, Unicode clipboard, renderer reattachment and disconnect passed |
| meereen | Server 2016, build 14393 | Default NLA with original policy | Login, desktop, keyboard, Unicode clipboard, renderer reattachment and disconnect passed |

The remote-screen test opened the connection dialog with the option off, enabled
it, confirmed that account/password/storage fields were absent, and reached the
Windows **Other user** screen with an empty initial credential identity. The
server certificate fingerprint was independently read over the management SSH
connection and matched before trust approval. Only then did the test driver enter
the disposable account credentials as RDP keyboard input. Launching Notepad and
reading back exact typed text and a Unicode clipboard marker proved a usable
authenticated desktop, beyond merely receiving frames. The harness restored all
local clipboard formats and closed Electron before publishing success evidence.
The first meereen NLA run authenticated but failed to open the test editor while
native window focus was being adjusted. A clean repeat without manual focus
interaction passed with no product change. The final result JSON is from that
successful repeat; the first attempt's failure screenshot remains separate.

Only kingslanding's `UserAuthenticationRequired` setting was changed, from 1 to 0
and back to 1. Its TLS `SecurityLayer` remained 2. A final SSH audit of all five
GOAD hosts confirmed their original NLA, registry, policy, TLS and certificate
settings. Pre-existing Robb Stark sessions on winterfell and castelblack remained
active. No Remote Desktop service restart or unrelated session logoff was used.

Native runtime identity:

- IronRDP fork: `bfa5a8966fce80d659765c018895036ec775a012`
- Helper SHA-256: `6f3617c28b9d13090d51cfac627b78fe58cd48bbcec2949f3e25b5491256d137`
- Build identity: `415ed5f794bea5376356fc79b20a567f801d0e49110de9af2c83630692a10365`

Generated private evidence is ignored under `artifacts/e2e/`:

- `rdp-signin-kingslanding-login-login-screen.png`
- `rdp-signin-kingslanding-login-result.json`
- `rdp-signin-{kingslanding,meereen}-nla-required-result.json`
- `rdp-signin-{kingslanding,meereen}-nla-result.json`
- `rdp-signin-goad-policy-audit.json`

Native tests verify exact TLS-only versus HYBRID-only protocol advertisement,
strict certificate handling, disabled autologon, empty remote-screen credentials,
and rejection of server-selected security modes that were not offered. NLA is
still the default for new connections and existing profiles with no mode field.
Unit coverage includes stored credentials, profile-mode changes, reconnection,
preload validation and temporary Overview connection forms.

Completed checks: 5,542 unit tests passed (3 skipped), 34 native tests passed,
8 focused Electron cases passed, TypeScript/application/E2E builds passed, and
protocol/parity/provenance checks passed. The rebuilt host helper passed its
architecture, ABI and self-test checks. Test-only private credential files and
SSH helpers were removed after the final policy audit.

Remote-screen login was exercised on the Server 2019 host only; the Server 2016
host retained NLA throughout. Windows/Linux local clients, installed packages
and additional Windows login providers were not exercised in this acceptance run.
