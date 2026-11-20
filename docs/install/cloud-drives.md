# Cloud drives

People can add attachments from Dropbox, Box, and Google Drive once an admin registers an app with each provider.  Each person then connects their own account, with OAuth 2 and PKCE, and Riosoma copies only the files they pick into its own file storage, through the same size limit, type detection, and previews as an upload.

Each provider's app can come from the server's settings or from admin settings:

- **Settings.**  Set the provider's settings from the [settings reference](settings.md#cloud-drives), such as `RIOSOMA_DROPBOX_APP_KEY` and `RIOSOMA_DROPBOX_APP_SECRET`.  They win over anything saved in the app, and admin settings can then only turn the provider off.
- **Admin settings.**  An owner, or an admin with the Integrations role, goes to Settings, then Integrations, enters the app's ID and secret, and chooses Test, then Save in the fixed save bar at the bottom of the page.  Secrets are sealed with the instance key.

Either way, Integrations shows the exact redirect address to register, and a switch that turns each provider off.  A provider appears in attachment fields only while its app is complete and it's turned on.

## The redirect address

Every provider sends people back to one address per provider on this server's base address (`RIOSOMA_BASE_URL`):

| Provider | Redirect address |
|---|---|
| Dropbox | `https://riosoma.example.com/api/oauth/callback/dropbox` |
| Box | `https://riosoma.example.com/api/oauth/callback/box` |
| Google Drive | `https://riosoma.example.com/api/oauth/callback/google` |

Register it exactly, with the scheme and no trailing slash.  Set `RIOSOMA_BASE_URL` before registering, since the address comes from it.

## Dropbox

1. In the Dropbox App Console, create an app with **Scoped access** and **Full Dropbox** access, so people can pick from anywhere in their Dropbox.
2. Under **Permissions**, turn on `account_info.read`, `files.metadata.read`, and `files.content.read`, and submit.
3. Under **Settings**, add the redirect address under **OAuth 2 Redirect URIs**.
4. Copy the **App key** and **App secret** into `RIOSOMA_DROPBOX_APP_KEY` and `RIOSOMA_DROPBOX_APP_SECRET`, or into Integrations.
5. A new app works for its developer and up to 500 people.  Apply for production in the App Console before rolling it out more widely.

## Box

1. In the Box Developer Console, create a **Custom App** with **User Authentication (OAuth 2.0)**.
2. Under **Configuration**, add the redirect address under **OAuth 2.0 Redirect URI**, and under **Application Scopes**, turn on **Read all files and folders stored in Box**.
3. Copy the **Client ID** and **Client Secret** into `RIOSOMA_BOX_CLIENT_ID` and `RIOSOMA_BOX_CLIENT_SECRET`, or into Integrations.
4. If the Box enterprise requires it, have a Box admin authorize the app in the Box Admin Console.

## Google Drive

Google Drive needs an OAuth client and an API key from the same Google Cloud project.

1. In the Google Cloud console, pick or create a project, and enable the **Google Drive API** and the **Google Picker API**.
2. Under **Google Auth Platform**, set up the consent screen, and add the scope `https://www.googleapis.com/auth/drive.file`.  That scope reaches only the files each person picks, so Google treats it as non-sensitive.
3. Under **Clients**, create a **Web application** client.  Add this server's origin, such as `https://riosoma.example.com`, under **Authorized JavaScript origins**, and the redirect address under **Authorized redirect URIs**.  Copy the client ID and secret into `RIOSOMA_GOOGLE_OAUTH_CLIENT_ID` and `RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET`, or into Integrations.
4. Under **APIs and services**, then **Credentials**, create an **API key**.  Restrict it to the **Google Picker API**, and to websites at this server's origin.  Every browser that opens the Picker receives it, so it isn't a secret, but the restriction keeps it from being used elsewhere.  Copy it into `RIOSOMA_GOOGLE_PICKER_API_KEY`, or into Integrations.

While Google Drive is set up and turned on, the content security policy lets the app load Google's Picker script from `https://apis.google.com` and open its frame from `https://docs.google.com`.  Otherwise the policy names no Google host at all.  The Picker's script loads only when someone opens it.

Google Docs, Sheets, and Slides are exported when they're copied, as PDF unless the person chooses Word, Excel, or PowerPoint.  Google exports files up to 10 MB this way.

## Testing an app

Integrations has a Test button for each provider.  It checks the client ID and secret with the provider's token address, which answers differently for a client it knows, and for Google, checks the API key.  It can't sign anyone in, so connecting a real account is the final check: connect one from Settings, then Connected accounts, and add a file from each drive to an attachment field.

If a provider later refuses the app itself, such as when its secret was changed at the provider but not here, people see a message asking an admin to check the app, and the server logs the refusal as an error.  Their connections are kept, and they work again once the right secret is saved, without anyone connecting again.  Only a provider refusing a person's own tokens asks that person to connect again.

## What's kept

- Each person's tokens, sealed with the instance key, until they disconnect.  Disconnecting also asks the provider to revoke them.  Access tokens are refreshed a few minutes before they expire.
- A connection that's under way, for ten minutes and one use, tied to the session that started it.
- The copied files, like any other attachment, which go through the same virus scanning and quarantine as uploads.  Removing a provider's app or turning it off leaves them in place.

## GitHub app sources

GitHub uses the same connected-account settings as cloud drives.  Create an OAuth app in GitHub under Settings, Developer settings, OAuth Apps.  Register the exact callback address shown under Riosoma's Settings, Integrations, such as `https://riosoma.example.com/api/oauth/callback/github`.  Enter its client ID and client secret on that page, or set `RIOSOMA_GITHUB_OAUTH_CLIENT_ID` and `RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET`.  Server settings take precedence, and admins can turn the provider off.

Each person connects their own GitHub account when adding an app source.  The source stores the connection ID, and scheduled syncs run as that connected account.  Access credentials remain sealed on the server.  Disconnecting warns about sources using the account.

The requested scopes are `repo read:org`.  GitHub OAuth apps have no read-only scope for private repositories.  Riosoma only reads repositories, issues, and pull requests, despite the broader authorization.  Tokens do not expire on a timer, but revoking authorization requires reconnecting.  See [GitHub's scope documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## Xero app sources

Register a Xero OAuth app with the callback address shown under Settings, Integrations, such as `https://riosoma.example.com/api/oauth/callback/xero`.  Enter its credentials there, or set `RIOSOMA_XERO_CLIENT_ID` and `RIOSOMA_XERO_CLIENT_SECRET`.  Server settings take precedence.

Xero requests `openid`, `profile`, `email`, `offline_access`, `accounting.invoices.read`, `accounting.payments.read`, `accounting.banktransactions.read`, `accounting.contacts.read`, `accounting.settings.read`, and `accounting.manualjournals.read`.  The [granular scope reference](https://developer.xero.com/documentation/guides/oauth2/scopes/) groups invoices, credit notes, quotes, purchase orders, and items under the invoice scope.  The source reads accounting data without changing it.

Choose an organization shared by the connected account when setting up a source.  A single organization is selected automatically.  Each source keeps its organization choice, and every accounting request identifies that organization.  Organization choices stay with the sealed connection, so no database migration is needed.  Connect again to refresh the organization list after changing access in Xero.

## QuickBooks Online app sources

Register an Intuit OAuth app with the callback address shown under Settings, Integrations, such as `https://riosoma.example.com/api/oauth/callback/quickbooks`.  Enter its credentials there, or set `RIOSOMA_QUICKBOOKS_CLIENT_ID` and `RIOSOMA_QUICKBOOKS_CLIENT_SECRET`.  Server settings take precedence.

QuickBooks Online requests `com.intuit.quickbooks.accounting`, `openid`, `profile`, and `email`.  The accounting scope permits writes at Intuit, but Riosoma reads records through GET queries.  The company selected during consent is kept with the account.  Choose Production for live companies, which is the default, or Sandbox for companies connected with development credentials.  Intuit uses separate [OpenID identity services](https://static.developer.intuit.com/output_html/qbo/docs/develop/authentication-and-authorization/openid-connect.html) for production and sandbox credentials.

A permission refusal leaves the affected object out and explains the provider's refusal.  A revoked or expired connection asks its owner to connect again.  Both accounting providers rotate refresh credentials, and Riosoma preserves the newest value for scheduled syncs.
