# AD collector compatibility

AD Explorer's default collector list pins exact artifacts. The SharpHound CE
and RustHound-CE artifacts below passed GOAD collection and Beagle import
through the desktop workflow. Signed RustHound-CE v2.5.30 also passed
current-user collection on sessions and beacons, and explicit-credential
collection on the existing Meereen session. This is a point-in-time
compatibility record, not a claim that every mode or future release works.

## Verified collectors

The native-file verified choice is [SharpHound CE v2.17.1](https://github.com/SpecterOps/SharpHound/releases/tag/v2.17.1)
from the official Windows release ZIP. The downloaded ZIP matched its published
SHA-256 file: `638d6d408f87067a664b381efc11dae5d76bcbfb451452453145f963c709b24a`.
Its `SharpHound.exe` digest is
`23e7bc671921d86ce5d78e47fc5c0baafe1633cfa477637e7635fa76462c9d05`.
The same executable digest appears in the prior successful GOAD collection
provenance under the ignored `artifacts/beagle-live-20261023T053452Z/` directory.
The public [Beagle verification record](beagle-verification.md) describes the
schema-v6 ZIP import, graph analysis, and desktop investigation checks.

The same release ZIP contains `SharpHound.ps1` with SHA-256
`83b964ec3848609ed7ac81ed103e0664860c86b499b3f151365a283b359f7fe9`.
Its pinned `Invoke-BloodHound` path also passed a live GOAD collection and
automatic Beagle import. Both pinned artifacts appear in the verified picker;
the executable is selected first among SharpHound choices. Other versions of either artifact remain
explicit operator-supplied choices.

The installed [sliverarmory RustHound-CE v2.5.29 release](https://github.com/sliverarmory/RustHound-CE/releases/tag/v2.5.29)
was the first verified picker choice on Windows/amd64 when its DLL matches the
signed v2.5.29 release DLL SHA-256
`d31f7bcbc9176fa7928302cfdab72b865d9539a61e2f2350085442f0f2368c64`.
This 15,363,072-byte GNU Windows DLL came from the tag-built release Actions
artifact and was confirmed byte for byte inside the signed Armory archive.
All three exposed methods passed GOAD session and beacon collection followed
by automatic Beagle import. The GUI test manually staged files extracted from
the signed archive; it did not exercise Armory installation itself.

The newer [sliverarmory RustHound-CE v2.5.30 release](https://github.com/sliverarmory/RustHound-CE/releases/tag/v2.5.30)
is the default when installed. Its Armory archive SHA-256 is
`5f9e9542fe9fbd0e2887b9f6944637bc5ae86b01c1a80117ceaad05e79347062`.
The archive's Minisign signature and trusted manifest verified against the
package key in the signed default Armory index; the Windows GNU DLL matches
the manifest SHA-256
`7e072a170992d332b6f0862f706bcfeec494b6b9a9a8602e5280f90a9b42aba1`.
This release adds current-user authentication through the target process's
Windows logon. The GUI only enables that mode for this exact version and DLL
digest. All three exposed methods passed GOAD current-user collection on a
session and beacon, automatic Beagle import, and an automatically populated
graph. The installed package was updated through production Armory catalog,
signature, and archive verification before testing.

A SharpHound Armory alias appears in the default list only when its executable
bytes match the pinned SharpHound digest above. The installed [SharpHound3](https://github.com/sliverarmory/SharpHound3)
and [SharpHound4](https://github.com/sliverarmory/SharpHound4) packages do not
qualify by their names or manifests. Each verified file choice checks its digest
again immediately before execution.

Beagle currently accepts SharpHound AD ZIP/JSON records with `meta.version` 5
or 6 and its supported AD collection types. It does not accept arbitrary
BloodHound CE, Azure, or OpenGraph outputs. The local importer defines the
authoritative check; file extensions and collector names are insufficient.

## Operator-supplied collectors

The Advanced section allows an operator to choose a SharpHound-compatible
Windows `.exe` or an `Invoke-BloodHound` PowerShell `.ps1`. These are explicit
choices and do not appear as verified defaults. The integrated workflow sends
fixed collection method, domain, and output options, saves the returned ZIP in
`~/.sliver-client/gui/ad-explorer/collections/<domain>/`, then requests Beagle
import. If Beagle rejects the ZIP, the app reports a saved-but-not-imported
result. That validation establishes compatibility of the produced data only;
it is not a trust check on operator-supplied code.

## Other collectors considered

| Collector | Current decision | Reason |
| --- | --- | --- |
| [BloodHound.py CE](https://github.com/dirkjanm/BloodHound.py/tree/bloodhound-ce) | Next candidate for an operator-host network collector | Its CE branch emits SharpHound-compatible AD data, but needs its own credential, DC, and network workflow plus an exact GOAD ZIP-to-Beagle test. |
| [sliverarmory/RustHound-CE](https://github.com/sliverarmory/RustHound-CE) | Integrated in-memory Sliver extension on Windows/amd64 | Signed v2.5.29 passed explicit-credential collection and signed v2.5.30 passed current-user collection for LdapOnly, DCOnly, and All on sessions and beacons, with automatic Beagle import. The v2.5.30 workflow also opens a populated graph. |
| [NetExec BloodHound CE](https://github.com/Pennyw0rth/NetExec/releases) | Lower priority network integration | Its release supports a BloodHound CE collector, but it adds a larger tool and credential workflow around collection; test its exact ZIP with Beagle before showing it by default. |
| [BOFHound](https://github.com/coffeegist/bofhound#versions) | Candidate for future BOF-log ingestion | Current releases support CE output and ADCS, but parse separate ldapsearch BOF logs. It needs a log capture/import workflow and exact GOAD-to-Beagle validation. |
| [SOAPHound](https://github.com/FalconForceTeam/SOAPHound#collecting-bloodhound-data) | Exclude from defaults | Its documented BloodHound v4 output is outside Beagle's currently accepted schema versions. |
| AzureHound and OpenGraph collectors | Exclude from AD defaults | Beagle's current importer handles SharpHound AD records, not these formats. |

The [sliverarmory fork](https://github.com/sliverarmory/RustHound-CE) is the only
RustHound source used by the new integration. Its dedicated Windows x64 DLL is
loaded from the Armory extension through Sliver's Reflektor path. The
extension receives typed options and current-user authentication or transient credentials, keeps the
ZIP in target memory, and returns bounded chunks over Sliver. AD Explorer
checks the whole ZIP and SHA-256 before saving it in the private client
directory and importing it into Beagle. The GUI also checks the installed DLL
against the SHA-256 recorded in its Armory manifest and the exact compatibility
allowlist. The v2.5.30 acceptance used a package installed through production
Armory signature verification; the earlier v2.5.29 tests staged verified files
manually and did not exercise installation.
The older SharpHound `.exe` and `.ps1` choices use their own target-side output
paths. RustHound is the collector with the in-memory, no-target-output-file
workflow.

The extension targets Windows/amd64. The signed v2.5.30 GNU DLL supports
current-user authentication through the target process's domain logon, with
Kerberos for LDAP and the same Windows identity for SMB and Remote Registry.
That mode sends no user name or password in the Start request. Explicit user
name and password authentication remains available, including on the verified
v2.5.29 DLL. These credentials are not saved in GUI preferences or collector
results. Sliver persists beacon task requests and responses on its server,
which includes an explicit-credential Start request. That is a server-side
data boundary even though the collector does not write its code or output to
the target disk. Other platforms need their own build and loader validation
before appearing in the picker.

With explicit credentials, the default is LDAP simple bind on port 389: the
supplied password travels from target to DC without TLS. AD Explorer also
offers an LDAPS switch, which encrypts that connection, but this RustHound
fork currently disables DC certificate verification for LDAPS. The UI
discloses these conditions before explicit credential submission. Current-user
mode uses the target's Kerberos logon and does not supply a password. The
v2.5.30 current-user path accepts the optional DC FQDN; the explicit-credential
path connects using the DNS domain and ignores that optional FQDN. Earlier
explicit-credential GOAD runs filled `winterfell.north.sevenkingdoms.local`,
but did not establish that it controlled the connection destination. The
v2.5.30 matrices leave that field empty.

## Fork DLL GOAD and Beagle validation

### Desktop collection workflow

Selecting a Windows target fills the collector form from its domain assignment
or a bounded `USERDNSDOMAIN` hint. The hint works for sessions and correlated
beacon tasks. Current-user RustHound can also leave the domain blank and use
native discovery; the validated collected-domain record in the returned ZIP
then becomes the target's saved domain assignment. Explicit credentials still
require a DNS domain.

Installing or updating Armory refreshes the collector list automatically and
selects the admitted RustHound build unless the operator explicitly chose a
different collector. Its default authentication is **Current user**. This uses
the target process's domain logon: an SSH key logon can have a domain-qualified
username without usable Kerberos credentials. Such failures now show a fixed,
actionable explanation without displaying raw native errors or credentials.

Collection progress and transferred bytes are owned by Electron main and can
be restored after leaving and returning to AD Explorer. **Cancel collection**
cancels only the correlated beacon task/native run and waits for confirmed
resource release. Closing the workspace also waits for that cleanup.

Every saved ZIP receives a durable recovery handle before automatic import.
If import fails, **Saved collections** offers **Retry import** and **Show file**;
these survive restart and do not run the collector again. Main validates the
managed file and its digest before recovery, and removes the pending receipt
only after import commits.

A successful import opens the domain's AD Explorer window with a bounded
**Directory overview** graph. Later collections refresh that overview in the
same window. Existing custom investigations and edited queries are retained,
with a notice that new collection data is available.

The opt-in production Electron runner and its exact-target inputs are described
in [Repeatable GOAD collector acceptance](ad-collector-goad-e2e.md).

### v2.5.30 current-user acceptance

On October 25, 2026 (UTC), the production Electron build passed the repeatable
GOAD runner against disposable Winterfell Windows/amd64 session and beacon
processes with full domain logons. The shared installed Armory package was
updated from v2.5.29 to signed v2.5.30 using production `ArmoryService` catalog,
archive, and signature verification. Its 15,490,560-byte DLL matches the
v2.5.30 digest recorded above.

Each transport first started an `All` collection, cancelled it through the GUI,
confirmed native resource release without saving a ZIP or opening a graph,
and then passed all three collection methods. Neither test entered an AD
password or a DC FQDN. The session's domain hint populated its form; the beacon
left the domain blank to exercise native discovery.

| Method | Target | ZIP bytes | ZIP SHA-256 | Beagle graph after import |
| --- | --- | ---: | --- | --- |
| LdapOnly | session | 36,628 | `1a0ac9a012272ad49c250941279ff1a43093154a2842be3f375d5411e7398da1` | 246 nodes, 2,226 relationships |
| LdapOnly | beacon | 36,636 | `d6e89b74a6bc9d409a2ea49239e3113de6e55a03ab73da90f8d5ab1912286fb6` | 246 nodes, 2,226 relationships |
| DCOnly | session | 36,603 | `7eb61f6da6a0ada61bc8a01076366d36ee2076d4a54a8fc618696c688dae57a7` | 246 nodes, 2,226 relationships |
| DCOnly | beacon | 36,626 | `e911a8cc40ecd1b8634689db6bfd8e1436a0a8d590f5b839b87102421bb5e511` | 246 nodes, 2,226 relationships |
| All | session | 37,212 | `ccc108781c7e7109a8704f84ab422eaf6422d294772494742398b6c24b6fc820` | 253 nodes, 2,241 relationships |
| All | beacon | 37,213 | `3e2ecd25ce21325387da3f22376e48057eb28b903460d3cdc2c9c248ce332ea2` | 253 nodes, 2,241 relationships |

Every successful run automatically displayed a fresh overview containing 45
nodes and 40 relationships before the test issued any query. Repeated imports
reused the same domain project and exact window. Count queries agreed with
project statistics, and each untouched ZIP's SHA-256 matched Beagle import
provenance. Both scenarios reported zero renderer and CSP errors, removed their
copied operator profiles, and left no pending recovery receipts.
After testing, both exact test-owned Windows processes and their SSH holders
were stopped; the original three lab sessions remained active. No remote
files were created, and beacon task history was retained.

The private evidence root is `/private/tmp/ad-current-user-goad-acceptance/`,
with session summary/screenshots in `sliver-ad-session-CZmXGo/` and beacon
summary/screenshots in `sliver-ad-beacon-ow5x8A/`. Armory update proof and the
previous package backup are under `/private/tmp/rusthound-installed-update-jINqSZ/`.
The test artifacts and operator credentials are not repository inputs.

The final local validation also passed 6,259 unit tests (4 intentionally
skipped), production build/typechecking, the two relevant Electron collection
window scenarios, protocol/parity/client-provenance checks, and the opt-in
runner's disabled-by-default check. Recovery tests cover restart, ZIP digest
changes, malformed receipts, import failure/retry, and concurrent retry
admission. Navigation and graph tests cover reattachment, discovered-domain
persistence, stale responses, and preservation of custom investigations.

### Meereen cloud-session authentication verification

The Winterfell matrix above did not cover the operator's existing Meereen
session on the cloud server. On October 25, 2026 (UTC), its reported failure was
reproduced in the GUI using the same installed v2.5.30 DLL and default
**Current user** authentication against `essos.local`.

The original session `039d175c-7f21-41cd-9dc0-1b7a80bd7e5f` ran as
`ESSOS\vagrant`, PID 5780. Its primary token had a Kerberos Network logon
(type 3), authentication ID `0x255e848`. A ticket-cache query scoped to that
logon found one ticket and no TGT. Both Sliver `UseToken=false` and
`UseToken=true` diagnostic children inherited this same authentication ID;
there was no alternate credential-bearing logon in that comparison. Historical
records did not establish how the original process was launched, so an SSH-key
origin is not a confirmed finding. An absent TGT alone is not sufficient to
diagnose missing credentials; the failed collection and controlled comparison
below provide the behavioral evidence.

A temporary process on the same Meereen host used the same executable hash,
same domain account, and same cloud server, with a full domain logon (type 2)
and a TGT. That session, `d327b77d-8c82-429e-86e5-ece61985b663`, passed the
production Electron cancellation exercise and all three current-user methods.
The collector form received no AD password or DC FQDN.

| Method | ZIP bytes | ZIP SHA-256 | Imported graph |
| --- | ---: | --- | --- |
| LdapOnly | 37,967 | `bce53781f319115e35cad213b55638750fa096e990ebb980f47bac9dc99edd5c` | 252 nodes, 2,451 relationships |
| DCOnly | 38,433 | `f3454227878967eac94da57a6bc5c42922995064e5989b2d2f3af0818644e208` | 252 nodes, 2,451 relationships |
| All | 38,940 | `5258bc8cb4920b30e6a4e6f5a138840f03dff62a47c351788648f935afbc2031` | 256 nodes, 2,484 relationships |

Each import automatically displayed a fresh 40-node overview before the test
queried the graph. All three imports reused one project and window, matched
ZIP provenance, and reported zero renderer or CSP errors. The temporary process
was removed afterward; the original process, executable, and logon were
preserved. The original session still requires a usable domain logon or
explicit AD credentials for collection; this successful comparison did not
repair its Windows logon.

The runner's explicit `EXPECT_NO_CREDENTIALS=1` mode then passed against the
original session: two distinct current-user LDAP attempts showed the exact
credential error, saved zero ZIPs or recovery artifacts, and opened no graph.
The second completed failure verifies that the first did not leave the target
busy. This is expected-rejection coverage, with zero successful collections;
it does not count as successful current-user collection. Both renderer and CSP
error counts were zero. The updated runner passed Node typechecking, E2E
compilation, and the disabled-by-default check.

Private positive evidence is under
`/private/tmp/ad-cloud-meereen-auth-e2e-20261025/sliver-ad-session-Hy4vs7/`.
The negative summary and screenshots are under
`/private/tmp/ad-cloud-meereen-auth-negative-20261025/sliver-ad-session-cZo7Oj/`.
Authentication and cleanup evidence are
`/private/tmp/rusthound-cloud-meereen-auth-proof-20261025.json` and
`/private/tmp/rusthound-cloud-meereen-cleanup-proof-20261025.json`.

### AD credentials on the existing Meereen session

On October 25, 2026 (UTC), the production Electron runner passed with
`AUTH=credentials` against the original Meereen session
`039d175c-7f21-41cd-9dc0-1b7a80bd7e5f`, PID 5780. It verified the default
current-user selection, selected **AD credentials** in the GUI, and filled the
actual masked password and AD user controls using a private lab credential
fixture. The domain was `essos.local`; LDAP and the empty optional DC hostname
retained their defaults. The installed signed RustHound v2.5.30 DLL was unchanged.

| Method | ZIP bytes | ZIP SHA-256 | Imported graph |
| --- | ---: | --- | --- |
| LdapOnly | 37,978 | `4f0503ae2f8c5936a85f3ad41dec415638e8db3f4af62ae1cc865e919b755357` | 252 nodes, 2,451 relationships |
| DCOnly | 38,417 | `1ec896d66c97b090f94b3de437fa77edb6d22606f4978e1d630405604f22e328` | 252 nodes, 2,451 relationships |
| All | 38,975 | `6c25e9d4a9a40352ba09e309c24f18cead1411060d44cbe7ff794b0fbced8202` | 256 nodes, 2,484 relationships |

Every method automatically opened or refreshed the same domain project and
graph window with a fresh 40-node overview before the test issued any query.
ZIP hashes matched import provenance, and graph count queries matched project
statistics. Cancellation and subsequent collection also passed. The GUI cleared
the password after cancellation and each collection; there were zero renderer
and CSP errors. The full live scenario completed in about 76 seconds.

This test used the existing process throughout. Final read-only verification
confirmed its executable hash, creation time, and original Network logon
authentication ID `0x255e848` were unchanged. No replacement target was
created. Explicit LDAP authentication does not repair that process's
current-user Windows logon.

The repeatable runner accepts only a path to the private credential fixture;
credential values were absent from command arguments, environment variables,
test reports, and screenshots. The temporary fixture and copied operator
profile were removed. Typechecking, E2E compilation, and the runner's
disabled-by-default check passed.

Private summaries and automatic-graph screenshots are under
`/private/tmp/ad-cloud-meereen-explicit-e2e-20261025/sliver-ad-session-ZuKMp0/`.
The final target verification is
`/private/tmp/ad-cloud-meereen-explicit-cleanup-20261025.json`.
These lab artifacts are not repository inputs.

### Retained Meereen current-user session

At the operator's request on October 25, 2026 (UTC), a new ordinary process was
started on Meereen under a password-backed domain logon and retained for use:
**meereen-current-user**, session `a994de98-0a39-4121-bb85-a335252c44ea`,
PID 1768. It uses the existing executable, with SHA-256
`5df011d85edcd026ede817038a0233b1a4c63c58227f7547b773d3048efcca34`.
Its primary token has an Interactive logon (type 2), authentication ID
`0x51b5435`, with a TGT present. It remained active after the setup SSH
connection exited. There is no SSH holder, automatic stop timer, scheduled
task, new remote file, or reboot startup. The original session and process
remain intact.

The existing production Electron runner passed with `AUTH=current-user`, no
credentials-file input, and the signed installed v2.5.30 collector. It verified
the current-user default and absence of a password field, automatic domain
suggestion, cancellation, collection, ZIP provenance, automatic populated
graphs, and refresh of the same project/window across the method matrix.

| Method | ZIP bytes | ZIP SHA-256 | Imported graph |
| --- | ---: | --- | --- |
| LdapOnly | 37,982 | `105b98690c6a0ffab1d6ecb5350451c3002d011fa7d876a0afb8d1c1b91d0f75` | 252 nodes, 2,451 relationships |
| DCOnly | 38,446 | `2f235f9cd0d28adf49dd128c8a826a95827fa47bfbb4c3cae64f8a6ec7be5984` | 252 nodes, 2,451 relationships |
| All | 38,512 | `9c64abdee68ea26585f9050c1d25d10edda4c4cca8d87c377aece8cc0351ebbd` | 258 nodes, 2,466 relationships |

Each successful import displayed a fresh 40-node overview before any test
query. The scenario finished in about 81 seconds with zero renderer or CSP
errors, and its copied operator profile was removed. Unlike the disposable
comparison above, this session was intentionally left running for the operator.

Private evidence is under
`/private/tmp/meereen-current-user-retained-e2e-20261025/sliver-ad-session-YiJ3rA/`.
Provisioning evidence is
`/private/tmp/meereen-current-user-provisioning-proof-20261025T034827Z.json`.
Final read-only verification at 03:54:33 UTC confirmed both the retained and
original sessions remained active with unchanged process/logon identities;
the retained session still had a TGT. That evidence is
`/private/tmp/meereen-current-user-retained-final-20261025.json`.
The new session was also selected in the operator's existing GUI with
**Current user** authentication. Initial native automation errors prevented
confirmation in that window; the follow-up below completes that verification.

### Current user in the operator's existing GUI

On October 25, 2026 (UTC), **Run collector** was clicked in the existing
operator GUI with `meereen-current-user` (`a994de98`) selected, domain
`essos.local`, RustHound CE v2.5.30, **Domain controllers**, and **Current user**.
The optional DC hostname was empty, LDAPS was off, and no AD credentials were
entered. No isolated application or acceptance runner was launched for this
check.

The existing app automatically opened its AD Explorer window with the
`AD essos.local` project containing **252 objects and 2,451 relationships**.
Its first **Directory overview** snapshot was created at 03:56:12 UTC and
displayed **40 objects and 40 relationships**. Neither **Open Explorer** nor
**Run query** was clicked before observing the populated graph. The graph
window was left open for the operator.

The actual managed archive,
`~/.sliver-client/gui/ad-explorer/collections/essos.local/rusthound-7d90be5d-4e83-47df-aacc-70db20539d6f.zip`,
was saved at 03:56:11 UTC: 37,975 bytes, SHA-256
`62bfef542a39ad6e534582abbc060a6be4b26d6b7931772aaf44d328f8cdbfff`.
The selected Beagle project's completed import at 03:56:12 UTC records the
same filename, size, and digest, and the same 252-node/2,451-relationship totals.

Native control reported window/capture errors and initially returned stale
state, but refreshing the application binding exposed the completed graph.
No AppleScript fallback was used. The screenshot of the existing application
is `/private/tmp/meereen-current-user-existing-gui-20261025.png`.

### Earlier v2.5.29 acceptance

The exact v2.5.29 DLL above was taken from the tag-built Actions artifact and
matched the DLL inside its Minisign-verified Armory release archive byte for
byte. The signed archive SHA-256 was
`128e48f132d20f0258e2e86685f0dfe06c41f1a8836f733860ed2214ad45bab1`.
Each test launched an isolated production Electron profile, selected RustHound
as the first verified collector, and ran one method on a disposable castelblack
Windows/amd64 session or beacon. Every run saved a checked ZIP on the client,
automatically imported it into a fresh Beagle project, opened the standalone
graph window, and reported zero renderer or CSP errors.

| Method | Target | ZIP bytes | ZIP SHA-256 | Beagle graph after import |
| --- | --- | ---: | --- | --- |
| LdapOnly | session | 35,969 | `cbd2a281a2e26f01b43a90454f2649b6566bcfb12e6eb4e9a79297869cb02d98` | 237 nodes, 2,177 relationships |
| LdapOnly | beacon | 35,968 | `9d6c3710b9d0e18875bf13c35c1a9a547558a1139d916f8f2682605eb6a4d7dc` | 237 nodes, 2,177 relationships |
| DCOnly | session | 36,418 | `60ed5cd91535ce5b5446fcb658e2eb6a7e49828766bd5e98b01956ebe2a4a2f3` | 237 nodes, 2,177 relationships |
| DCOnly | beacon | 36,420 | `c0815916e66bb9c495e4b59e240cf75227c55c1b7670a3b784c7b5e75ddddc10` | 237 nodes, 2,177 relationships |
| All | session | 37,017 | `7b6bcda83cc1548809297f78b535c808c749b13867c6eef35f9e488b48109e13` | 239 nodes, 2,201 relationships |
| All | beacon | 37,038 | `643561f2e347fda29b96029bfd54e296e9bca1a5b4bd76b166108913a23e766a` | 242 nodes, 2,212 relationships |

Method-specific summaries are in the private
`/private/tmp/rusthound-gui-signed-release/` evidence directory. Credential-free
AD Explorer and Beagle screenshots are under its `run-LZdOXN/` directory. The
copied operator config was removed after each run. The public `sliver-script`
SDK package was then updated to the published, provenance-verified
`sliver-script@2.0.0-rc.6` release and installed with
`npm ci --strict-allow-scripts`. A fresh production Electron run with the same
signed RustHound DLL passed `LdapOnly` on both targets: the session produced a
35,972-byte ZIP (`ca22bfa1b2250f8c3acf30341b6e5f4e98b54819d0b2b5630842caa0ee95c3a5`)
and the beacon produced a 35,996-byte ZIP
(`01327bd77b8c4766f6a40f0f37a7e3ca307a2324f4d847791a10bb8da8d0318c`).
Each was saved and automatically imported into the standalone Beagle window as
237 nodes and 2,177 relationships, with zero renderer or CSP errors. Sanitized
summaries are in `/private/tmp/rusthound-gui-sdk-rc6/`; the copied operator
config was removed after both runs.

### Earlier local GNU prototype

On October 23, 2026, a local GNU test DLL with SHA-256
`95dce65bdbcb5f0f744599f5459b36a7dbc825ef0f45aa0a4ad32bdb52ac5d12`
ran on the GOAD castelblack
Windows/amd64 session and a fresh Windows/amd64 beacon. Each run used
`LdapOnly` against `north.sevenkingdoms.local`, transferred bounded chunks
from the extension's in-memory ZIP, saved a complete SHA-256-checked ZIP under
the isolated client root, and automatically imported the untouched ZIP into
the standalone Beagle window. Both imports produced 237 nodes and 2,177
relationships, and a graph query returned the same node count. The complete
Electron renderer, preload, typed IPC, Sliver adapter, collection, save,
Beagle import, and graph-window path reported zero renderer page or CSP errors.

| GOAD target | ZIP bytes | ZIP SHA-256 | Beagle graph |
| --- | ---: | --- | --- |
| castelblack session | 35,965 | `155963349525741043484d26b0f8c802125a9fa4b057f6d113e018823e686c72` | 237 nodes, 2,177 relationships |
| castelblack beacon | 35,951 | `9bcfd501e735970803a24ca45152c14bd3426f7ce2c6094051e653e0582b8947` | 237 nodes, 2,177 relationships |

Sanitized summaries and credential-free screenshots are in the private
`/private/tmp/rusthound-gui-live/run-YxiiDQ/` evidence directory. The operator
config copied into that isolated profile was removed after each test. The
original pre-GUI fork ZIP also imported unchanged through the bundled Beagle
CLI into a separate isolated database: 237 nodes and 2,177 relationships.
The GUI ZIP envelope check was extended for ZIP64 per-entry sizes because
the fork's ZIP writer uses them even for small collections.
The prototype digest is absent from the production verified allowlist.

## Prior upstream RustHound EXE GOAD compatibility probe

On October 23, 2026, the official [RustHound-CE v2.5.27 Windows MSVC x64
release](https://github.com/g0h4n/RustHound-CE/releases/tag/v2.5.27) was
downloaded and its archive SHA-256 checked against the release asset digest
`4ec71f9cf864e72827680b692ea3b97333646aae401bdb543bfc828081aa93cd`.
The contained `rusthound-ce.exe` SHA-256 was
`e1de83f84ad07a25e30733e5bdc15f23cfd63f4521550d6034177904745d81b5`.
Sliver uploaded and ran that binary on the active GOAD winterfell session with
RunAs using a disposable lab credential outside the collector command line. It
produced a 36,672-byte ZIP, SHA-256
`a04a903a1173353b970b6901396a629097316cf4fa3a0616855caba45f7efb71`,
containing 13 schema-v6 AD JSON collections and 208 records. The unique remote
executable, ZIP, and directory were removed after download.

The **unmodified ZIP failed Beagle import** at `certtemplates.json` record 28:
`unknown or non-ACL RightName "AutoEnroll"`. A diagnostic copy that removed
only nine such ACEs reached a second failure at `enterprisecas.json` record 1:
`unknown AD object type "LocalGroup"`. The tagged [RustHound ACL writer](https://github.com/g0h4n/RustHound-CE/blob/v2.5.27/src/enums/acl.rs)
emits both labels. Current [BloodHound CE graph kinds](https://github.com/SpecterOps/BloodHound/blob/main/packages/go/graphschema/ad/ad.go)
define `Enroll` and `ADLocalGroup`, but not `AutoEnroll` or `LocalGroup`; its
[ACE importer](https://github.com/SpecterOps/BloodHound/blob/main/packages/go/ein/ad.go)
skips unknown rights. A further **diagnostic-only** copy that skipped those
nine ACEs and mapped three CA ACE `PrincipalType` values from `LocalGroup` to
`ADLocalGroup` imported into the current Beagle CLI: 246 nodes and 2,226 total
edges after analysis. This transformed copy does not prove that the original
collector output is compatible.

This was an **upstream EXE test**, before the sliverarmory fork's in-memory DLL
integration. It must not be used as evidence that the fork's DLL works or that
its output imports into Beagle. The Armory-style Sideload attempt returned
without a ZIP. Native execution
without `-k` waited for RustHound's credential prompt; native execution with
`-k` failed because the selected session had no usable Kerberos credentials.
The existing Sliver RunAs RPC succeeded without placing the password in
RustHound's arguments. The later sliverarmory fork corrected both schema
labels, emits the ZIP in memory, and sends its untouched bytes through
Start/Status/Read/Finish calls. Its exact tested DLL hash and session/beacon
results are recorded above.

## Live desktop acceptance

The opt-in GOAD test used the production Electron renderer, preload, IPC,
Sliver client adapter, collector, saved ZIP, Beagle import, and standalone
window. On October 23, 2026, an isolated desktop profile completed collections
on two active GOAD sessions. Both ZIPs contained 15 SharpHound schema-v6 AD
JSON files. Each import opened a separate domain project and returned a nonempty
graph query. The run reported zero renderer page or CSP errors.

| Target | AD domain | ZIP SHA-256 | Beagle graph |
| --- | --- | --- | --- |
| winterfell | `north.sevenkingdoms.local` | `72950844aaf8385e0250423c1de78a6ce468a82a781d1f25898eaf7b5d050c86` | 356 nodes, 3,381 edges |
| kingslanding | `sevenkingdoms.local` | `cb92af486cc9feb29bf3516db252dfce9708a787d1626aac5819c7bcac277540` | 355 nodes, 3,799 edges |

Separate live runs selected the Advanced operator-supplied `.exe` on
kingslanding and the official `Invoke-BloodHound` `.ps1` through the Advanced
script path on winterfell. Both saved a schema-v6 ZIP, imported it into Beagle,
opened the standalone window, and passed a graph query. The Advanced `.exe`
produced 355 nodes and 3,799 edges; the script produced 356 nodes and 3,381
edges. The pinned script was subsequently added as a verified choice.
A final live run selected that new verified PowerShell entry through the
verified collector menu, checked its pinned script digest, and imported a
45,660-byte schema-v6 ZIP with SHA-256
`744dd304fd0c6980c34c61b2f0150d7865be81256f85774a38c1701813ac237b`.
Its Beagle project had 356 nodes and 3,381 edges, with zero page or CSP errors.

The Electron runs used isolated application data, removed copied operator
profiles, and read-only target checks confirmed no generated ZIP or script
remnants on winterfell or kingslanding. Private evidence remains under ignored
`/private/tmp/sliver-ad-collector-validation/run-r668mj/`, `run-Coda8w/`, and
`run-gR0cPN/`, and `run-tpwQJI/` directories. A separate meereen attempt produced no ZIP;
SharpHound's bounded `--version` diagnostic reported that target needs .NET
Framework 4.7.2. The desktop reports this known prerequisite directly.
This earlier SharpHound desktop test did not exercise a live beacon because
its available GOAD beacon was stale. The later RustHound session and beacon
tests are recorded above.
