# AWS authentication

In **Cloud Deployment → Credentials → Add Credential**, choose the method
your AWS identity already uses. An existing local profile is selected by
default when one is available. Without a profile, the form requires an
explicit authentication choice.

| Method | Use it for | Renewal |
| --- | --- | --- |
| **AWS CLI Profile** | Existing console, IAM Identity Center (SSO), access-key, credential-process, or supported role profiles | The official AWS SDK resolves the profile. The app shows guidance for its effective authentication method. |
| **AWS Login** | IAM users and supported federated console identities | The app opens AWS in the system browser and retains a refreshable session. No AWS CLI is required. |
| **Access Keys** | Credentials obtained through an existing authorized workflow | Enter the session token as well when using temporary credentials. Manually entered credentials are not automatically renewed. |

Native IAM Identity Center onboarding is **not implemented in this first
reliability update**. SSO users must configure and sign in to an AWS CLI
profile, then reopen the form and choose that profile. Identity Center requires
an organization that has enabled it and assigned access; it is not a universal
replacement for console sign-in. Interactive profile MFA prompts and remote
device-code entry are also unavailable in this screen.

For **AWS Login**, choose the AWS region and select **Sign In to AWS Console**.
The app opens the normal AWS Management Console first. Sign in to the intended
account and confirm that its console loads. Federated users should use their
usual organization sign-in in the same browser profile if needed. Return to
the app and select **Continue to Authorization**, then approve the new request
in that same browser profile. Renewal of an existing credential follows the
same two steps and requires the original identity.

This console step repairs an expired browser session before authorization.
The app cannot inspect that session: opening the page or returning to the app
does not verify sign-in. Continue is your confirmation that the intended
account's console is accessible. The authorization request, local callback,
and ten-minute deadline start only after Continue, so time spent signing in
to the console does not consume the authorization deadline.

IAM users and roles need the permissions provided by
`SignInLocalDevelopmentAccess`. Root users do not require that policy. The
browser and app must run on the same computer.

Access keys remain an optional compatibility path, not the default. Temporary
credentials are useful only if you already have a working way to obtain them;
the app does not create that alternative identity workflow for you.

## Profile capabilities and existing credentials

The **AWS Login** renewal action is available for native console credentials
and direct console-login profiles that support it. SSO, static-key,
credential-process, and assumed-role profiles receive guidance for renewing
their existing source instead. A role profile whose source uses console login
still needs its role/source workflow; direct console login would not preserve
that role assumption.

Capability discovery reads bounded shared configuration files without resolving
credentials or invoking credential processes. It accounts for credentials-file
precedence, nested profile sources, and cycles. Summary metadata contains the
authentication method and whether console renewal is supported, without secret
values or login identity ARNs.

Renewing an eligible credential preserves its saved credential ID, SSH key,
and deployment references. The signed-in identity must match the original
identity, including the configured `login_session` for a console profile. A
different identity is rejected. Valid shared profile credentials take precedence
over the app's saved browser session. Existing credentials do not require a
vault migration, and the app does not rewrite shared AWS configuration files.
If a profile changes its authentication method or login identity, the app
refuses to fall back to its previously saved console session. It rechecks this
binding after a pending refresh completes.

## Progress, cancellation, and refresh

After console sign-in, the app distinguishes opening authorization in the
browser, waiting for AWS authorization, and exchanging the returned
authorization. While waiting, **Copy Sign-in Link** offers browser recovery.
**Start Over** cancels and settles the old request, then returns to console
sign-in. A fresh authorization request starts only after Continue. The
add-credential form also offers **Choose Another Method** after
cancelling the pending request. Closing or navigating away from the initiating
window cancels its login.

Native console sessions attempt refresh on credential use once five minutes
or less remain. Concurrent callers share the refresh. A temporary network or
service failure can keep the existing credentials usable while more than
15 seconds remain; a 30-second cooldown bounds repeated refresh attempts.
The next credential use after the cooldown can retry. Expired or nearly expired
credentials are not reused, and permission/session-invalid errors are not
silently treated as transient failures. AWS can ultimately require a new
browser sign-in. Shared profiles retain the official SDK's refresh behavior.

Session material uses Electron's encrypted credential vault. If secure OS
storage is unavailable, it remains only for the current application session.
Tokens and signing keys stay in the main process and do not enter renderer
snapshots.

Successful renewal checks saved deployments that use that credential. Status
checks also run every 30 seconds while the Cloud Deployment window is visible,
when returning to it, and when selecting **Refresh**. A successful status read
clears stale authentication errors; incomplete setup and failed operations
remain available for review.

## Recovering from Amazon's 400 Bad Request page

An expired AWS web-console session can cause **400 Bad Request** after you
select an account. Signing in to the normal console and starting a fresh app
authorization resolved this reported failure. In this case, AWS does not
return to the app, so the login
continues waiting until cancelled or its ten-minute deadline expires. The app
cannot observe the AWS browser page or its response status. AWS tracks this behavior in
[AWS CLI issue #10186](https://github.com/aws/aws-cli/issues/10186).

The console-first flow incorporates that recovery before authorization. It
does **not automatically detect expiry or guarantee avoidance of every AWS
browser-side 400**. Running the AWS
CLI's console `aws login` uses the same AWS console authorization service and
is not an independent fallback for that failure.

If AWS still displays 400, select **Start Over** in the app. Sign back in to the
intended account in the console that opens, then select **Continue to
Authorization**. Select that same identity when AWS asks for an account.
Simply retrying authorization while the browser session is expired repeats
the failure.

As a secondary option, while authorization is pending, select **Copy Sign-in
Link**. Sign in to the normal console in a private browser window on the
**same computer**, then paste the copied link in that same private window.
Keep the app's request pending until approval finishes; cancelling, closing
the app window, or timing out invalidates the link.

Copy the link from the app instead of Amazon's error page: the app retains the
original authorization request. Copying neither starts a new login nor changes
the account being renewed. The link is available only to the window that
started the pending login and is withdrawn when AWS returns its authorization.

Private browsing can avoid stale browser sessions but does not resolve missing
IAM permissions or every AWS service error. If it still fails, check the
`SignInLocalDevelopmentAccess` policy for an IAM user or role. IAM Identity
Center users should use **AWS CLI Profile**. The app does not clear browser
cookies or embed the AWS sign-in page.

## Diagnostics and verification limits

Token-service errors can include a validated HTTP status, an allowlisted AWS
error code, and a UUID-format AWS request ID when supplied. Raw service messages,
authorization codes, full authorization URLs, tokens, and credential material
are excluded from these error details. Browser-only failures cannot supply
token-service diagnostics because no token request has happened yet.

When reporting a failure, include the application version, operating system,
browser, selected method and region, the phase shown by the app, and any safe
error details. Do not attach the full browser address, authorization link, AWS
configuration contents, or tokens.

Automated tests exercise local callbacks, synthetic SDK profiles, IPC/UI
behavior, and simulated refresh responses. They do not establish real AWS
browser compatibility. The [authentication acceptance checklist](aws-login-verification.md)
defines the separate live release gate; its existence is not evidence that
those checks have been run.

Protocol references: [AWS console sign-in URLs](https://docs.aws.amazon.com/signin/latest/userguide/sign-in-urls-defined.html),
[AWS console credential login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html),
[AWS Sign-In API reference](https://docs.aws.amazon.com/signin/latest/APIReference/signin-api.pdf),
[AWS Sign-In token API](https://docs.aws.amazon.com/cli/latest/reference/signin/create-oauth2-token.html),
and the [official AWS CLI login implementation](https://github.com/aws/aws-cli/tree/v2/awscli/customizations/login).
