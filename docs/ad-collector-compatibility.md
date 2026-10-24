# AD collector compatibility

AD Explorer's default collector list pins exact artifacts. The SharpHound CE
and RustHound-CE v2.5.29 artifacts below passed GOAD collection and Beagle
import through the desktop workflow. The newer signed RustHound-CE v2.5.30
default has not yet passed that live acceptance. This is a point-in-time
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
digest. A v2.5.30 GOAD collection and Beagle import have not yet been run, so
the signature and hash checks establish artifact identity but not output
compatibility or live authentication success.

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
| [sliverarmory/RustHound-CE](https://github.com/sliverarmory/RustHound-CE) | Integrated in-memory Sliver extension on Windows/amd64 | The exact signed v2.5.29 GNU DLL passed GOAD collection and automatic Beagle import for LdapOnly, DCOnly, and All on both a session and a beacon. The newer signed v2.5.30 DLL adds current-user authentication; its live GOAD/Beagle acceptance remains pending. |
| [NetExec BloodHound CE](https://github.com/Pennyw0rth/NetExec/releases) | Lower priority network integration | Its release supports a BloodHound CE collector, but it adds a larger tool and credential workflow around collection; test its exact ZIP with Beagle before showing it by default. |
| [BOFHound](https://github.com/coffeegist/bofhound#versions) | Candidate for future BOF-log ingestion | Current releases support CE output and ADCS, but parse separate ldapsearch BOF logs. It needs a log capture/import workflow and exact GOAD-to-Beagle validation. |
| [SOAPHound](https://github.com/FalconForceTeam/SOAPHound#collecting-bloodhound-data) | Exclude from defaults | Its documented BloodHound v4 output is outside Beagle's currently accepted schema versions. |
| AzureHound and OpenGraph collectors | Exclude from AD defaults | Beagle's current importer handles SharpHound AD records, not these formats. |

The [sliverarmory fork](https://github.com/sliverarmory/RustHound-CE) is the only
RustHound source used by the new integration. Its dedicated Windows x64 DLL is
loaded from the Armory extension through Sliver's Reflektor path. The
extension receives typed domain, method, and transient credentials, keeps the
ZIP in target memory, and returns bounded chunks over Sliver. AD Explorer
checks the whole ZIP and SHA-256 before saving it in the private client
directory and importing it into Beagle. The GUI also checks the installed DLL
against the SHA-256 recorded in its Armory manifest and the exact compatibility
allowlist. Normal Armory installation verifies the signed package; the manual
on-disk setup used for GOAD testing does not exercise that signature check.
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
mode uses the target's Kerberos logon and does not supply a password. Operators
can specify a DC FQDN when the target cannot resolve the domain. The GOAD run
used `winterfell.north.sevenkingdoms.local`.

## Fork DLL GOAD and Beagle validation

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
