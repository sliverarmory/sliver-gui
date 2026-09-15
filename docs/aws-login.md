# AWS Login

In **Cloud Deployment → Credentials → Add Credential**, select **AWS Login**,
choose the AWS region, and select **Sign In and Save**. Complete the AWS sign-in
and approval in your default browser, then return to the app. The AWS CLI is
not required for this path.

If shared AWS profiles are available, the form selects **AWS CLI Profile** by
default. The official AWS SDK resolves the selected profile, including cached
console login credentials, SSO, credential processes, and supported role
profiles. Access keys can still be entered manually.

Use **AWS Login** on an existing console-login credential or its failed
deployment card to sign in again. This preserves the saved credential ID, SSH
key, and deployment references. For an existing CLI console-login profile, use
the same AWS identity configured by its `login_session`; a different identity
is rejected. Valid shared profile credentials take precedence over the app's
saved browser session. The app does not modify shared AWS configuration files.

Temporary credentials refresh automatically while AWS permits the session to
continue. AWS eventually requires browser sign-in again. Session material is
stored through Electron's encrypted credential vault; if secure OS storage is
unavailable, it is kept only for the current app session. Tokens and signing
keys stay in the main process and never enter renderer snapshots.

You can cancel a pending login in the app. Closing or navigating away from its
window also cancels the login. Successful sign-in immediately checks the saved
deployments that use that credential. A successful status read clears stale
authentication errors from completed deployments.

Cloud Deployment checks AWS and Azure status every 30 seconds while its window
is visible, when you return to the window, and when you select **Refresh**.
These checks update instance state, health, and addresses. Status-read failures
appear separately and clear when a later check succeeds. Incomplete setup and
failed operations remain available for review; retry the desired action as needed.

This implements AWS console login for IAM users and supported federated
identities. IAM Identity Center SSO continues to use the shared AWS profile
and its existing SSO login flow. Interactive profile MFA prompts and remote
device code entry are not implemented by this login screen. AWS may require
the `SignInLocalDevelopmentAccess` policy on the signing-in identity.

## Recovering from Amazon's 400 Bad Request page

AWS can reject an existing browser session with **400 Bad Request** after you
select an account. In this case, AWS does not return to the app, so the login
continues waiting. AWS tracks this behavior in
[AWS CLI issue #10186](https://github.com/aws/aws-cli/issues/10186).

While AWS Login is still pending, select **Copy Sign-in Link** in the app. Open
a private browser window on the **same computer**, paste the copied link, and
complete sign-in with the original AWS identity. Keep the app's login pending
until sign-in finishes; cancelling, closing the app window, or timing out
invalidates the link. Start AWS Login again if that happens.

Copy the link from the app instead of Amazon's error page: the app retains the
original authorization request. Copying neither starts a new login nor changes
the account being renewed. The link is available only to the window that
started the pending login and is withdrawn when AWS returns its authorization.

Private browsing can avoid stale browser sessions but does not resolve missing
IAM permissions or every AWS service error. If it still fails, check the
`SignInLocalDevelopmentAccess` policy for an IAM user or role. Root users do not
require that policy. IAM Identity Center users should use **AWS CLI Profile**.

Protocol references: [AWS console credential login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html),
[AWS Sign-In token API](https://docs.aws.amazon.com/cli/latest/reference/signin/create-oauth2-token.html),
and the [official AWS CLI login implementation](https://github.com/aws/aws-cli/tree/v2/awscli/customizations/login).
