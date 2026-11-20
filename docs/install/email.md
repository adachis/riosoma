# Email

Riosoma sends one-time sign-in links, invitations, notifications, booking confirmations, and scheduled reports by email.  `RIOSOMA_MAIL_TRANSPORT` picks the service each message goes out through, and `RIOSOMA_MAIL_FROM` is the sender whichever way it goes.

| Transport | Setting | Good for | Signs in with |
|---|---|---|---|
| An SMTP server | `smtp` (the default) | A mail server you already run or rent | A user and password in the address |
| Amazon SES | `ses` | AWS, and the cheapest high-volume sending | An access key, or the task's or instance's role |
| Azure Communication Services | `acs` | Azure | The resource's access key, or a managed identity |
| Microsoft Graph | `graph` | A mailbox in Exchange Online | An app registration's client secret |
| Gmail | `gmail` | A mailbox in Google Workspace | A service account with domain-wide delegation |
| A relay of your own | `relay` | One outbound HTTPS address and nothing else | A shared secret, signed per post |

Whatever the transport:

- **Email is off until it's configured.**  With `smtp`, that means no `RIOSOMA_SMTP_URL` or no `RIOSOMA_MAIL_FROM`, and the features that need email say so rather than failing.  Any other transport is one you asked for by name, so a setting it needs is checked when the server reads its settings, and the server stops with a line naming that setting if one is missing.
- **Every message is built the same way.**  The transports that send raw content (SES, Graph, and Gmail) build the MIME with the same composer the SMTP transport uses, so headers, attachments, and encodings match whichever way a message goes out.  Azure Communication Services and a relay take the message as JSON instead, with attachments base64-encoded.
- **A busy service is waited out.**  A `429` or `5xx` answer is tried again three times, backing off from half a second, and a `Retry-After` answer is waited out for up to a minute.  Anything else fails at once.
- **A failure says which transport failed and why.**  The error a send throws names the transport, the service's status, and its own short code, as in `Amazon SES could not send the message: the service answered HTTP 400 MessageRejected`, and it never carries a message body, a key, or a token.  A failed sign-in link or invitation is logged as `mail_delivery_failed`, and a failed notification as `notification email failed`.  With any transport but `smtp`, those log lines also carry `transport`, `status`, and that `reason`.  An SMTP server's own error text can quote the message, so with `smtp` they carry only a short code.  A failed report keeps the failure's short code, such as `http_400`.

Settings marked secret belong in the platform's secret store.  The [settings reference](settings.md#sign-in-and-email) lists every one with its default.

## SMTP

The default, and the one that works with any mail server: your own Postfix, a mailbox provider's submission address, or a service like Mailgun or Postmark that offers SMTP.

```bash
RIOSOMA_MAIL_TRANSPORT=smtp
RIOSOMA_SMTP_URL=smtps://user:password@smtp.example.com:465
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
```

`smtps://` is TLS from the start, usually on port 465.  `smtp://` must upgrade with STARTTLS, usually on port 587, and refuses to send a password or a message in plain text without it.  Percent-encode special characters in the password.  `RIOSOMA_SMTP_ALLOW_PLAINTEXT=true` lets `smtp://` deliver without TLS, which is only for a local mail catcher in a test, and the server logs a warning while it's on.

**Test.**  Ask for a sign-in link on your Riosoma sign-in page and watch the mailbox.  Without a mailbox to check, `swaks --to you@example.com --from riosoma@example.com --server smtp.example.com:465 --tls` sends the same way from the same network, so it tells a mail server problem from a Riosoma one.

## Amazon SES

SES sends raw MIME over its v2 API, signed with Signature Version 4.  On AWS, leave the keys out and let the task's or instance's role sign.

### What to set up at AWS

1. Verify the sender: a domain with its DKIM records, or a single address while you try it out, in the region you'll send from.
2. While the account is in the SES sandbox, only verified addresses can receive mail too, so request production access before real people use it.
3. For keys rather than a role, make an IAM user with a policy that allows `ses:SendEmail` on the verified identity, and put both halves in the secret store.
4. For a role, give the task or instance role the same policy.  Riosoma reads the standard AWS environment variables, then a task's container credentials endpoint, then the instance metadata service (IMDSv2), so ECS, EKS with Pod Identity, and EC2 all work with nothing extra configured.  EKS's older IAM roles for service accounts hand out a web identity token, which Riosoma doesn't read, so use Pod Identity or keys there.

### Settings

```bash
RIOSOMA_MAIL_TRANSPORT=ses
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
RIOSOMA_SES_REGION=eu-west-1
# With keys rather than a role:
RIOSOMA_SES_ACCESS_KEY_ID=AKIA...
RIOSOMA_SES_SECRET_ACCESS_KEY=...
```

Outbound HTTPS to `email.<region>.amazonaws.com` on port 443 has to be open.  The call names the bare sender address, and the name in `RIOSOMA_MAIL_FROM` rides in the message's own `From` header.

**Test.**  `aws sesv2 list-email-identities --region eu-west-1` shows whether the sender is verified with the same credentials.  Then ask for a sign-in link, and read the `reason` of any `mail_delivery_failed` line in the log: `400 MessageRejected` means the address isn't verified or the sandbox is blocking the recipient, `403 AccessDeniedException` means the keys or role lack `ses:SendEmail`, and `the server has no AWS keys to sign with` names the place Riosoma looked for a role's keys and what it found there.

## Azure Communication Services

An Azure Communication Services resource with an email communication resource attached sends the message, and answers with an operation Riosoma follows for up to a minute until the send succeeds or fails.

### What to set up in Azure

1. Create an Azure Communication Services resource, and an Email Communication Services resource with a domain: the Azure managed one, or your own once it's verified.  Connect the domain to the Communication Services resource under **Email > Domains**.
2. Use one of the domain's sender addresses in `RIOSOMA_MAIL_FROM`, such as `DoNotReply@<domain>` or one you add under **MailFrom addresses**.  The service takes a bare address, so the name people see is the one set on that sender address in Azure, not the name in `RIOSOMA_MAIL_FROM`.
3. Choose how the server signs in:
   - **A managed identity**, which is the better choice in Azure: turn a system-assigned identity on for the service Riosoma runs as (Container Apps or App Service), or use AKS workload identity, and give it the **Communication and Email Service Owner** role, or **Contributor**, on the Communication Services resource.  A user-assigned identity can't be chosen here, except through AKS workload identity's own `AZURE_CLIENT_ID`.
   - **An access key**: copy the resource's connection string into the secret store.

### Settings

```bash
RIOSOMA_MAIL_TRANSPORT=acs
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
# With a managed identity:
RIOSOMA_ACS_ENDPOINT=https://<resource>.<region>.communication.azure.com
# Or with a key, which carries the endpoint too:
RIOSOMA_ACS_CONNECTION_STRING='accesskey=...;endpoint=https://<resource>.<region>.communication.azure.com/'
```

A call with a key is signed with the HMAC-SHA256 the service documents, over the method, the path with its query, and the date, host, and body hash.  With no key, a token for `https://communication.azure.com/.default` rides along instead, from the same identity code the database and the blob store sign in with.  Set both an endpoint and a connection string and the endpoint wins.

**Test.**  `az communication list-key --name <resource> -g <group>` shows the connection string and confirms the name.  Then ask for a sign-in link.  A send that fails reports the service's own code in the log line's `reason`, such as `InvalidSender` for an address the resource can't send as, a managed identity that gets no token is reported as a failed sign-in, and a send that doesn't finish in a minute is reported as still running.

## Microsoft Graph

A mailbox in Exchange Online, called through Graph's `sendMail` with the message's MIME base64-encoded, using an app-only token from the client credentials flow.

### What to set up in Entra ID and Exchange Online

1. Register an application in Microsoft Entra ID and note its directory (tenant) ID and application (client) ID.  [Microsoft 365](microsoft-365.md) walks through it, and one app can send email and read Microsoft 365 sources too.
2. Give it the **Mail.Send** application permission (not the delegated one) and grant admin consent.
3. Add a client secret and copy its value into the secret store, noting its expiry.
4. Create the mailbox itself, such as `riosoma@example.com`, and turn off its interactive sign-in if nothing will use it.
5. Scope the permission to that mailbox.  Without this, `Mail.Send` as an application permission can send as every mailbox in the tenant.  Exchange Online's RBAC for Applications does this, and so does the older application access policy it replaces:

   ```powershell
   Connect-ExchangeOnline
   New-ApplicationAccessPolicy -AppId <client ID> -PolicyScopeGroupId riosoma@example.com `
     -AccessRights RestrictAccess -Description 'Riosoma sends as this mailbox'
   ```

### Settings

```bash
RIOSOMA_MAIL_TRANSPORT=graph
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
RIOSOMA_GRAPH_TENANT_ID=11111111-2222-3333-4444-555555555555
RIOSOMA_GRAPH_CLIENT_ID=66666666-7777-8888-9999-aaaaaaaaaaaa
RIOSOMA_GRAPH_CLIENT_SECRET=...
RIOSOMA_GRAPH_SENDER=riosoma@example.com
```

`RIOSOMA_GRAPH_SENDER` is the mailbox the call sends from and has to be a bare address, while `RIOSOMA_MAIL_FROM` is what people see and may carry a name.  Use the same address in both.  A different address in `RIOSOMA_MAIL_FROM` needs Send As permission on it for the sending mailbox, or Exchange refuses the message.  Outbound HTTPS to `graph.microsoft.com` and `login.microsoftonline.com` has to be open.  A token is kept until five minutes before it expires, so a burst of messages asks for one token.

**Test.**  Check the app registration first, since a refused token and a refused send look alike in a mailbox that stays empty:

```bash
curl -sS -X POST "https://login.microsoftonline.com/$RIOSOMA_GRAPH_TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$RIOSOMA_GRAPH_CLIENT_ID" -d "client_secret=$RIOSOMA_GRAPH_CLIENT_SECRET" \
  -d 'scope=https://graph.microsoft.com/.default' -d 'grant_type=client_credentials' | head -c 120
```

An `access_token` means the credentials work, so a failure after that is the permission or its scope: `403 ErrorAccessDenied` in the log line's `reason` means `Mail.Send` hasn't been granted admin consent, or the policy that scopes the app leaves that mailbox out.

## Gmail

A Google Workspace mailbox, called through the Gmail API.  A service account with domain-wide delegation sends as the mailbox, so no password and no browser sign-in are involved.

### What to set up in Google Cloud and Workspace

1. Make a service account in a Google Cloud project and a key for it, and download the key's JSON.
2. Enable the Gmail API for that project.
3. In the Google Workspace admin console, under **Security > Access and data control > API controls > Domain-wide delegation**, add the service account's client ID with the scope `https://www.googleapis.com/auth/gmail.send`, which sends and does nothing else.
4. Create the mailbox, such as `riosoma@example.com`.

### Settings

```bash
RIOSOMA_MAIL_TRANSPORT=gmail
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
RIOSOMA_GMAIL_SENDER=riosoma@example.com
RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON="$(< service-account.json)"
```

The key file goes in the secret store as one value, just as Google hands it out.  A secret made from the file itself, such as `--from-file` in Kubernetes or a Secret Manager secret, does that.  `RIOSOMA_GMAIL_SENDER` is the mailbox the service account acts for and has to be in the delegated domain.  Gmail sends from that mailbox, so the address in `RIOSOMA_MAIL_FROM` has to be the same one, or one of its verified send-as aliases, and otherwise Gmail puts the mailbox's own address in its place.  Outbound HTTPS to `gmail.googleapis.com` and `oauth2.googleapis.com` has to be open.

**Test.**  Ask for a sign-in link and read the `reason` of any `mail_delivery_failed` line in the log.  `Gmail could not sign in` with `400 invalid_grant` means the delegation isn't in place or the scope doesn't match, and `403 PERMISSION_DENIED` on the send means the Gmail API isn't enabled for the project.  Neither is about the message itself.

## A relay of your own

`relay` posts each message to one HTTPS address as JSON, signed with a shared secret.  It suits an installation that can open exactly one outbound address, and a gateway that already talks to a mail service Riosoma has no transport for.

### Settings

```bash
RIOSOMA_MAIL_TRANSPORT=relay
RIOSOMA_MAIL_FROM='Riosoma <riosoma@example.com>'
RIOSOMA_MAIL_RELAY_URL=https://relay.example.com/outbound/mail
RIOSOMA_MAIL_RELAY_SECRET="$(openssl rand -hex 32)"
```

The address has to be `https`, or `http` on the machine Riosoma runs on, where a relay beside it can listen.  No credentials ride in the address, since every post is signed.

### What the relay receives

A `POST` with `Content-Type: application/json` and this body, where `headers` and `attachments` are left out when a message has none:

```json
{
  "from": "Riosoma <riosoma@example.com>",
  "to": "person@example.com",
  "subject": "Sign in to Riosoma",
  "text": "Use this link to sign in: https://riosoma.example.com/sign-in/link#token=...",
  "html": "<p>Use this link to sign in: <a href=\"...\">...</a></p>",
  "headers": { "List-Unsubscribe": "<mailto:list@example.com?subject=unsubscribe>" },
  "attachments": [
    { "filename": "report.csv", "contentType": "text/csv", "content": "bmFtZSx2YWx1ZQo=" }
  ]
}
```

Two headers sign it:

| Header | Value |
|---|---|
| `x-riosoma-timestamp` | When the post was signed, in Unix seconds |
| `x-riosoma-signature` | `v1=` and then the lowercase hex HMAC-SHA256 of the timestamp, a period, and the exact bytes of the body, keyed with `RIOSOMA_MAIL_RELAY_SECRET` as UTF-8 |

So the signed string is `<timestamp>.<body>`, with no trailing newline added and nothing else mixed in:

```
signature = "v1=" + hex(HMAC-SHA256(secret, timestamp + "." + body))
```

A relay checks the signature over the body as it received it, and refuses a post whose timestamp is further from its own clock than it allows, a minute or two, since a signature alone can't stop a captured post from being sent again.  It answers `200`, `201`, `202`, or `204` to take the message, `429` or `5xx` to ask Riosoma to try again, and anything else to refuse it for good.  Retries carry a fresh timestamp and signature.

Checking one in Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function signed(secret, timestamp, body, claimed) {
  const made = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
  const a = Buffer.from(made);
  const b = Buffer.from(String(claimed));
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Test.**  Point `RIOSOMA_MAIL_RELAY_URL` at a listener on the same machine, which prints the signature headers and takes the message:

```bash
RIOSOMA_MAIL_RELAY_URL=http://127.0.0.1:9000/outbound/mail
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class Relay(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['content-length']))
        print(self.headers['x-riosoma-timestamp'], self.headers['x-riosoma-signature'], len(body), 'bytes')
        self.send_response(202)
        self.end_headers()
HTTPServer(('127.0.0.1', 9000), Relay).serve_forever()
PY
```

Then ask for a sign-in link and watch the post arrive.  A relay that answers `429` with `Retry-After` is waited out, one that never answers is reported as unreachable after four attempts, and the log line's `reason` says which.

## Trying a transport out

Every transport is worth trying before real people depend on it.  Start the server with the settings, ask for a one-time sign-in link on the sign-in page, and read both ends:

```bash
# What the server said about a sign-in link or an invitation it couldn't send, and why.
docker compose logs riosoma | grep mail_delivery_failed
```

A message that doesn't arrive but isn't reported as failed is almost always at the provider: a sandbox, a suppressed recipient, a mailbox that isn't in scope of an access policy, or a domain whose DMARC record doesn't allow the sender.  The sender in `RIOSOMA_MAIL_FROM` is what people see, so give it a name and an address that answers to it, and set up SPF, DKIM, and DMARC for its domain whichever transport carries it.
