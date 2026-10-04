# AWS authentication acceptance

This is an unexecuted acceptance checklist, not a record of successful AWS
authentication. The first reliability update adds local regression coverage;
it does not include live account/browser verification or native Identity Center
onboarding. Do not claim AWS's browser-side 400 is fixed from these tests.

## Scope and prerequisites

Use only explicitly configured test identities whose owner has approved the
sign-in checks. Test the packaged application at the exact candidate commit
and record its version and artifact digest. Use a clean application data
directory with no managed deployments so credential renewal does not trigger
unrelated resource status reads.

Keep these checks limited to authentication and a read-only identity outcome.
Use an opt-in verifier that obtains credentials from the production adapter
under test and calls AWS STS `GetCallerIdentity` in the main process. Record
only whether the returned account and principal match the expected identity;
retain any exact identity record privately. Do not export vault secrets into
the renderer, terminal arguments, or evidence files.

The existing **Test Connection** action performs EC2 read and DryRun permission
probes. It is not an STS identity verifier. A CLI `GetCallerIdentity` check using
a separate credential source likewise does not prove that the app authenticated
correctly. If a verifier for the exact application adapter is unavailable, mark
the identity and refresh checks **not run** and keep that release gate open.
No resources need to be created, changed, or deleted for this checklist.

## Coverage to record

For every advertised packaged operating system, record the default browser and
at least one alternate browser/private-window attempt. Include at least two
independent users/accounts, including a user outside the developer's account.
Cover an eligible IAM console identity, a supported federated console identity
when claimed, and an existing organizational SSO profile. Record each tested
region; do not infer China/GovCloud or untested region coverage from a mocked
endpoint test.

| Candidate | OS/browser | Identity kind | Method | Region | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Not run | Not run | Not run | Not run | Not run | Not run | None |

Use **pass**, **fail**, **blocked**, or **not run**. A successful workaround is
recorded as a workaround, not as a normal-browser success. Mark unsupported
methods explicitly rather than silently omitting them.

## Repeatable scenarios

1. **Fresh installation and method choice.** With no discovered profiles, open
   Add Credential. Confirm that a method must be selected, that SSO guidance
   directs users to an existing CLI profile, and that access keys are not the
   default. Repeat with a configured profile and confirm it is selected.
2. **Native console sign-in.** Use AWS Login and confirm that the normal console
   opens first. No app authorization, callback listener, or token exchange
   should start before Continue to Authorization. Sign in to the intended
   account in that browser profile, return to the app, and continue. Observe
   authorization opening, waiting, and exchanging phases. Complete approval
   and verify the expected account and
   principal through the exact adapter. Record normal-browser and private-window
   results separately. Never copy authorization URLs into test evidence.
3. **Expired browser session and AWS 400.** Use an approved test identity whose
   console session has expired while its browser cookies remain. Signing out
   or using an empty browser profile is not equivalent. Confirm the console
   step requests sign-in, complete it, and continue with the same account and
   browser profile. Record whether approval succeeds. Also test a valid console
   session and multiple remembered accounts, choosing the intended refreshed
   identity. If AWS displays 400, confirm the app remains waiting and does not
   invent a token-service error. Start Over must cancel the old attempt, open
   the normal console, and wait for Continue before fresh authorization.
   Record whether console reauthentication resolves the failure. Test copied
   links in a signed-in private window separately as a secondary recovery.
4. **Cancellation and restart.** Cancel while waiting, close the initiating
   window, and use Start Over in separate attempts. The old attempt must not
   save a credential or replace a newer session. In the creation form, Choose
   Another Method must cancel first and return to an explicit choice. Cancel
   during console preparation and verify that later browser-launch completion
   or a return to the app does not start authorization. Repeated Continue must
   start only one request. Check that the copied old link becomes unusable
   after cancellation/expiry. Changing region or authentication method must
   require console preparation again.
5. **Identity binding.** Renew an existing console credential with its original
   identity and confirm its credential ID remains stable. In a separate
   controlled attempt choose a different approved test identity; replacement
   must fail and leave the original saved credential intact.
6. **Existing profile methods.** Select synthetic/local test configurations
   backed by authorized console, SSO, process, static, and assumed-role sources.
   Only direct eligible console profiles should offer AWS Login renewal.
   Follow the displayed source-specific guidance, then verify the effective
   identity through the application's provider. A role profile must retain its
   role chain even when its source uses console login. No interactive MFA
   support should be implied for profiles that require it.
7. **Refresh and restart.** For a native console credential, make an identity
   read once its remaining lifetime enters the five-minute refresh window.
   Confirm refreshed credentials produce the same identity. Repeat after an
   application restart when secure storage is available. Record session-only
   persistence separately when secure storage is unavailable.
8. **Transient failure.** Using a scoped test transport or controlled test
   network condition, interrupt only the token-refresh request while existing
   credentials remain valid. The app should not insist on browser login, should
   reuse credentials only with more than 15 seconds remaining, and should avoid
   repeated refresh attempts during the 30-second cooldown. Restore access and
   verify recovery on the next credential use after cooldown.
9. **Expiry and permissions.** Use prearranged expired/revoked test sessions and
   an eligible test identity without console-login permission. Confirm these
   differ from network failures and never reuse invalid credentials. Do not
   change production IAM policies to manufacture failures. Service simulation
   coverage must be labeled separately from real service observations.
10. **Diagnostics.** For a controlled token-service failure, check that only
    status, an allowed code, and a validated request ID are included when
    available. Inspect saved evidence for authorization URLs, codes, tokens,
    raw service messages, passwords, and key material; none should be present.

Temporary credentials entered manually are a compatibility path: test an
already authorized temporary credential set, including its session token, and
record expiry without expecting automatic renewal. The console `aws login`
command is not independent of the AWS browser service; its success or failure
should not be presented as a separate recovery protocol. Native SSO remains
unsupported in this delivery even if the existing SSO-profile scenario passes.

## Local regression checks

From the repository root, run the relevant suites and typechecking:

```sh
npm test -- src/main/cloud/aws-console-entry.test.ts src/main/cloud/aws-console-login.test.ts src/main/cloud/aws-shared-profiles.test.ts src/main/cloud/aws-shared-profiles-official.test.ts src/main/cloud-deployment-service.test.ts src/main/cloud-deployment-ipc.test.ts src/preload/cloud-deployment.test.ts src/renderer/src/CloudDeploymentWindowApp.test.tsx
npm run typecheck
```

These suites use synthetic files, injected providers, loopback callbacks, and
simulated service responses. They are useful regression checks, not evidence
of live AWS sign-in. The Electron fixture disables cloud login, so a passing
Electron run does not close this authentication acceptance gate.

## Release decision

Attach the exact candidate identifier and completed matrix to release evidence.
Keep untested platforms, identity types, regions, and recovery scenarios
explicit. General availability claims require real sign-in, identity, refresh,
and cancellation evidence for the supported paths. A reproducible AWS browser
400 remains an open upstream limitation even if private-window recovery passes.
