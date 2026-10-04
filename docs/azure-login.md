# Azure Login

In **Cloud Deployment → Credentials → Add Credential**, select **Azure** and
**Azure Login**, then choose **Sign In to Azure**. Complete Microsoft's sign-in
in your default browser, return to the app, choose a subscription, and save
the credential. This flow does not require the Azure CLI.

The form selects **Azure CLI** by default when local CLI subscriptions are
available. Existing CLI credentials continue to work. Use **Azure Login** on
an existing credential or its failed deployment card to add or renew a browser
session. Valid CLI credentials remain preferred for credentials originally
created from the CLI; the app uses the saved browser session if CLI token
acquisition fails. It does not modify the Azure CLI cache.

Re-login preserves the credential ID, tenant, subscription, SSH key, and
deployment references. A replacement browser session must retain the same
account once one has been saved. Successful sign-in immediately checks saved
deployments that use the credential and clears stale authentication errors
after a successful status read of a completed deployment.

Cloud Deployment also checks status every 30 seconds while visible, when you
return to the window, and when you select **Refresh**. Instance state and
addresses follow the current cloud state. Status-read failures clear when a
later check succeeds; incomplete setup and failed operations remain available
for review.

The optional **Directory (Tenant) ID** selects the directory to sign into.
Only enabled subscriptions in that directory are listed. Enter another
directory's tenant ID when you need to access its subscriptions. This flow
currently supports the public Azure cloud.

The optional **Application (Client) ID** lets an organization use its own
Microsoft Entra public-client registration. Configure its **Mobile and desktop
applications** platform with the `http://localhost` redirect and delegated
Azure Service Management `user_impersonation` permission. Tenant policy may
require administrator consent. If left blank, the app uses the Microsoft
development client also used by Azure Identity's default browser credential;
Microsoft recommends using your own app registration for production.

Microsoft's MSAL library handles browser authorization and silent token refresh.
The serialized MSAL cache stays in Electron main and is stored through the
encrypted credential vault. If secure OS storage is unavailable, credentials
are kept only for the current app session. Tokens and refresh material never
enter renderer snapshots. When Microsoft requires interaction again, use
**Azure Login** to renew the session. Native ARM claims challenges require
interactive sign-in; forwarding the challenge to browser authentication is not
yet supported.

You can cancel a pending login. Closing or navigating away from the window
also cancels it. A completed sign-in awaiting subscription selection expires
after ten minutes and is discarded when the form is closed or its
authentication settings change.

References: [Azure Identity browser credential options](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/interactivebrowsercredentialnodeoptions?view=azure-node-latest),
[desktop application registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration),
[MSAL Node token acquisition](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests),
and [Azure subscription discovery](https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list?view=rest-resources-2022-12-01).
