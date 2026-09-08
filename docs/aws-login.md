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
window also cancels the login. Login does not retry a failed server operation;
retry the desired action after sign-in succeeds.

This implements AWS console login for IAM users and supported federated
identities. IAM Identity Center SSO continues to use the shared AWS profile
and its existing SSO login flow. Interactive profile MFA prompts and remote
device code entry are not implemented by this login screen. AWS may require
the `SignInLocalDevelopmentAccess` policy on the signing-in identity.

Protocol references: [AWS console credential login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html),
[AWS Sign-In token API](https://docs.aws.amazon.com/cli/latest/reference/signin/create-oauth2-token.html),
and the [official AWS CLI login implementation](https://github.com/aws/aws-cli/tree/v2/awscli/customizations/login).
