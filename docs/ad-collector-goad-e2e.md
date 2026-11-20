# Repeatable GOAD collector acceptance

`npm run test:e2e:ad-collector-live` builds the production desktop app and runs
opt-in RustHound collection through its renderer, preload, IPC,
Sliver transport, managed ZIP storage, Beagle import, and graph window. With no
opt-in, both live scenarios are skipped. Authentication defaults to current user;
an explicit AD-credentials mode is described below. The ordinary test suite remains local.

Use a disposable GOAD range and **exact existing Windows/amd64 session and
beacon IDs**. The test does not generate implants, change logons, or stop
operator-owned processes. The current-user positive matrix requires both targets to already
have a usable domain logon.
A domain-qualified username alone is insufficient: sessions started through an
SSH key logon may lack Kerberos credentials. If collection reports that no
credentials are available in the security package, start a disposable target
under a full domain logon, then remove that test-owned process afterward. Do not
put domain passwords in environment variables or command arguments.

Install/update RustHound CE through the desktop Armory before running. The test
requires the exact current-user-capable DLL admitted by the GUI and verifies its
manifest and SHA-256 before copying only that package into an isolated profile.
It never modifies the supplied Armory root or original operator configuration.

```sh
SLIVER_GUI_AD_COLLECTOR_E2E=1 \
SLIVER_GUI_AD_COLLECTOR_E2E_CONFIG=/absolute/private/range-operator.cfg \
SLIVER_GUI_AD_COLLECTOR_E2E_ARMORY_ROOT=/absolute/private/.sliver-client \
SLIVER_GUI_AD_COLLECTOR_E2E_SESSION_ID=00000000-0000-0000-0000-000000000001 \
SLIVER_GUI_AD_COLLECTOR_E2E_BEACON_ID=00000000-0000-0000-0000-000000000002 \
SLIVER_GUI_AD_COLLECTOR_E2E_DOMAIN=north.sevenkingdoms.local \
SLIVER_GUI_AD_COLLECTOR_E2E_METHODS=LdapOnly,DCOnly,All \
SLIVER_GUI_AD_COLLECTOR_E2E_OUTPUT_DIR=/absolute/private/ad-collector-evidence \
npm run test:e2e:ad-collector-live
```

The UUIDs above are placeholders. `CONFIG`, `ARMORY_ROOT`, and optional
`OUTPUT_DIR` must be absolute paths. On Unix, the operator configuration must
have private permissions such as `0600`.

The default matrix runs `LdapOnly` on both targets. `METHODS` accepts any
comma-separated subset of `LdapOnly,DCOnly,All`. Each method imports into the
same domain project and reuses its open window, exercising graph refresh after
repeated collections when multiple methods are selected. Before the matrix,
each target starts an `All` collection, waits for native collection to start,
clicks **Cancel collection**, and requires confirmed cancellation without a
saved ZIP or open graph window. The following matrix verifies the target can
collect again after cancellation. For a focused rerun, set `MODES=session` or
`MODES=beacon`; omitted `MODES` requires both IDs. A focused run is not evidence
that the other transport passed; a single-method matrix does not test graph
refresh after a second successful import.

`WAIT_MS` sets the deadline for each method and the cancellation exercise (default 1,200,000 ms;
accepted range 30,000–14,400,000 ms). Use a fresh beacon with a short check-in
interval so registration, collection status, and each ZIP chunk can finish in
that budget. An overdue beacon is rejected before collection.

The current-user session scenario checks automatic domain hints when available. The beacon
scenario deliberately leaves the domain blank to exercise native discovery.
Current-user scenarios enter neither a password nor a DC hostname. Both assert that:

- RustHound is selected by default and authentication is `Current user`.
- The completed ZIP has a complete envelope, valid domain records, and a SHA-256
  matching Beagle's import provenance.
- The correct domain project opens automatically, contains nonzero data, and
  displays graph nodes **before the test issues any query**.
- A separate count query agrees with project statistics.
- Additional methods reuse the same dataset and graph window.
- Cancel reaches a confirmed terminal state, and subsequent collection succeeds.
- No renderer or CSP errors occur.

Each scenario uses its own private application data and client root. The copied
operator profile is removed in `finally`, and the owned Electron process is
closed. Without `OUTPUT_DIR`, all local test artifacts are removed. With it,
private ZIPs, Beagle databases, automatic-graph screenshots, and `summary.json`
are retained in a unique run directory; do not commit these lab artifacts.
The summary records only authentication mode, target identity, collector hash, counts, archive hash,
cancellation timing, and validation outcome. Fixed progress stages and collector
phase heartbeats are printed while running. Failures report a bounded category
such as an acceptance assertion, UI timeout, native collection failure, or
cancellation deadline. Raw RPC responses and credentials are not printed.

For explicit AD authentication, set `SLIVER_GUI_AD_COLLECTOR_E2E_AUTH=credentials`
and `SLIVER_GUI_AD_COLLECTOR_E2E_CREDENTIALS_FILE` to an absolute path to a private
JSON file. The file must contain exactly two string fields, `username` and
`password`. Use a bare username or UPN such as `collector@example.invalid`,
not `DOMAIN\user`. Create the file using a private editor or an approved secret
source; never put its values in environment variables, command arguments, or
shell history. The file must be a regular non-symlink file no larger than 16 KiB,
with permissions exactly `0600` on Unix.

```sh
SLIVER_GUI_AD_COLLECTOR_E2E=1 \
SLIVER_GUI_AD_COLLECTOR_E2E_AUTH=credentials \
SLIVER_GUI_AD_COLLECTOR_E2E_CREDENTIALS_FILE=/absolute/private/ad-credentials.json \
SLIVER_GUI_AD_COLLECTOR_E2E_MODES=session \
SLIVER_GUI_AD_COLLECTOR_E2E_CONFIG=/absolute/private/range-operator.cfg \
SLIVER_GUI_AD_COLLECTOR_E2E_ARMORY_ROOT=/absolute/private/.sliver-client \
SLIVER_GUI_AD_COLLECTOR_E2E_SESSION_ID=00000000-0000-0000-0000-000000000001 \
SLIVER_GUI_AD_COLLECTOR_E2E_DOMAIN=essos.local \
SLIVER_GUI_AD_COLLECTOR_E2E_METHODS=LdapOnly,DCOnly,All \
SLIVER_GUI_AD_COLLECTOR_E2E_OUTPUT_DIR=/absolute/private/ad-credentials-evidence \
npm run test:e2e:ad-collector-live
```

The credentials scenario first verifies the GUI's current-user default, then
selects **AD credentials**, fills the supplied `DOMAIN`, and fills the actual
**AD user** and masked **AD password** controls. It keeps the default LDAP
transport and empty optional DC hostname. It runs the same cancellation and
method matrix, including ZIP provenance and automatically populated graphs.
The private file is reread before each request because the application must
clear its password field after cancellation and collection. The test verifies
that clearing, clears both credential inputs, wipes file buffers, and clears
temporary credential references. It does not copy or delete the supplied
credentials file; remove that fixture separately when it is no longer needed.

Credential-mode reports include `authentication: "credentials"` but never the
supplied username or password. This mode captures only graph screenshots, never
the credentials workspace or an error page. `AUTH=current-user` restores the
default behavior. Combining `AUTH=credentials` with `EXPECT_NO_CREDENTIALS=1`
is rejected before connecting to a target.

To verify the failure path on an existing target whose Windows logon has no
usable domain credentials, set `SLIVER_GUI_AD_COLLECTOR_E2E_EXPECT_NO_CREDENTIALS=1`.
Use the same private configuration and Armory inputs, the target's expected
domain, and its exact ID. For a session-only negative check:

```sh
SLIVER_GUI_AD_COLLECTOR_E2E=1 \
SLIVER_GUI_AD_COLLECTOR_E2E_EXPECT_NO_CREDENTIALS=1 \
SLIVER_GUI_AD_COLLECTOR_E2E_MODES=session \
SLIVER_GUI_AD_COLLECTOR_E2E_CONFIG=/absolute/private/range-operator.cfg \
SLIVER_GUI_AD_COLLECTOR_E2E_ARMORY_ROOT=/absolute/private/.sliver-client \
SLIVER_GUI_AD_COLLECTOR_E2E_SESSION_ID=00000000-0000-0000-0000-000000000001 \
SLIVER_GUI_AD_COLLECTOR_E2E_DOMAIN=essos.local \
SLIVER_GUI_AD_COLLECTOR_E2E_OUTPUT_DIR=/absolute/private/ad-collector-negative-evidence \
npm run test:e2e:ad-collector-live
```

This explicit mode runs current-user `LdapOnly` twice, ignoring `METHODS` and
skipping the cancellation exercise and positive matrix. Each attempt must
reach a distinct terminal failed run, show the exact fixed error beginning
“The target's Windows logon has no usable domain credentials,” and create no
managed ZIP, recovery artifact, or graph window. Repeating the request verifies
that the first failure does not leave the target busy. `WAIT_MS` applies to
each attempt. `MODES=beacon` can exercise the same failure path on an exact
beacon target.

The test name and summary identify this as expected credential rejection.
`expectedOutcome` is `no-usable-domain-credentials`, `successfulCollections` is
zero, and `noCredentialsRuns` records both attempts. Passing this negative test
is evidence that the failure is handled correctly; it is not evidence of
successful current-user collection. The normal matrix remains the acceptance
test for collection, import, and a populated graph.

A failure identifies the validation stage and requests cancellation of the
matching active collection before closing the app. A deadline while collecting can
leave work pending on a beacon until its next check-in; use the GUI's Cancel
control or dispose of the explicitly test-owned target, and inspect the
collection's final state before reusing it. The test never deletes server-side
beacon task history.
