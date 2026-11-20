---
id: single-sign-on
title: Setting up single sign-on
summary: Let people sign in with Google, Microsoft Entra ID, or another OpenID Connect provider, and decide who gets an account.
area: administration
order: 2
level: advanced
related: [sign-in, setup, sign-in-policy, saml-single-sign-on]
routes: [/settings/sso, /settings/*/sso, /admin/*/sso]
anchors: [settings.sso]
sections: [settings.sso=the-callback-address]
---

Single sign-on lets people sign in with an account they already have.  Riosoma works with Google, Microsoft Entra ID, and any other provider that supports OpenID Connect, and with SAML 2.0 identity providers such as Okta, as {{doc:saml-single-sign-on}} explains.  Each provider you turn on adds a button to the sign-in page, and passwords and emailed links keep working beside it.

The organization's owner sets it up in {{ui:shell.nav.settings}}, then {{ui:settings.nav.sso}}.  Choose {{ui:sso.add}}, pick the kind of provider, fill in its settings, and choose {{ui:sso.save}}.  The list then shows each provider's kind, whether it's {{ui:sso.status.on}} or {{ui:sso.status.off}}, and how many people have signed in with it.  Open one to change it.

A provider can sign people in to accounts that already exist, the owner's included, so only an owner adds a provider, changes its issuer, tenant, client ID, or client secret, or turns on {{ui:sso.field.linkByEmail}}.  Admins given the Security role see every provider, and can rename one, turn it on or off, change its allowed domains and whether it creates accounts, turn linking off, and delete it.  They aren't offered {{ui:sso.add}}, and they see the settings only an owner changes without being able to edit them.

## The callback address

Each provider needs Riosoma's callback address registered in its console before anyone can sign in.  The form shows it under {{ui:sso.field.redirect}}, with {{ui:sso.copy}} beside it, and it's the same for every provider:

```
https://riosoma.example.com/api/auth/sso/callback
```

Riosoma builds it from `RIOSOMA_BASE_URL` when the server has one, and otherwise from the address you opened Settings at.  Without a base URL, open Settings at the address people use to reach Riosoma.  Register exactly what the form shows, because the scheme, host, port, and path all have to match.

## How sign-in works

Riosoma uses the OpenID Connect authorization code flow with PKCE, a state value, and a nonce, and takes callbacks only at its own address.  It asks for the `openid`, `email`, and `profile` scopes and reads these claims from the ID token:

| Claim | What Riosoma uses it for |
|---|---|
| `iss` and `sub` | Who the person is.  After the first sign-in, Riosoma recognizes people by these two, never by email. |
| `email` | Finding an existing account, or making a new one, on the first sign-in |
| `email_verified` | Whether the provider vouches for the address.  Microsoft Entra ID never sends it, so for Entra ID, Riosoma reads the optional `xms_edov` claim instead. |
| `name` | The name on a new account |

The first time someone signs in with a provider, Riosoma decides whose account it is:

1. If {{ui:sso.field.linkByEmail}} is on and the provider verified the address, the sign-in links to the member of your organization with that email address.
2. Otherwise, if {{ui:sso.field.autoCreate}} is on and the verified address is in one of the {{ui:sso.field.domains}}, Riosoma makes a new account.  It joins as a {{ui:people.kind.member}}, with no databases until someone shares one.
3. Otherwise, the sign-in page says "{{ui:sso.noAccount}}"

An address the provider hasn't verified never links to an account or makes one, since anyone could claim it.  After the first sign-in, the account stays linked to the provider's identity, even if the person's email address changes at the provider.  A provider signs people in to your organization only, and a deactivated account can't sign in.

## Google

1. In the Google Cloud console, choose a project and set up its OAuth consent screen.  Choose Internal to admit only your Google Workspace organization's accounts, or External to admit any Google account.  An External app admits only its test users until you publish it.  Riosoma's scopes need no review from Google.
2. Create an OAuth client ID with the application type Web application.
3. Under Authorized redirect URIs, add the callback address, then create the client.
4. Copy the client ID and client secret into {{ui:sso.field.clientId}} and {{ui:sso.field.clientSecret}}.

Riosoma fills in Google's issuer for you.  Google sends `email_verified` on its own, so linking and new accounts need nothing more.

## Microsoft Entra ID

1. In the Microsoft Entra admin center, open App registrations and choose New registration.
2. Under Supported account types, choose Accounts in this organizational directory only, unless people from other organizations need to sign in too.
3. Under Redirect URI, choose the Web platform and enter the callback address, then choose Register.
4. From the app's Overview, copy the Application (client) ID into {{ui:sso.field.clientId}}, and the Directory (tenant) ID into {{ui:sso.field.tenant}}.  Leave {{ui:sso.field.tenant}} empty only for an app registered for accounts in any organizational directory.  Riosoma then accepts any work or school account, and linking and {{ui:sso.field.domains}} decide who gets in.
5. Under Certificates & secrets, add a client secret and copy its Value, not its Secret ID, into {{ui:sso.field.clientSecret}}.  Secrets expire, so note the date and replace it in Riosoma before then.
6. Under Token configuration, choose Add optional claim, choose the ID token type, and select `email` and `xms_edov`.  If you're asked, turn on the Microsoft Graph email permission.  If `xms_edov` isn't offered, add it to the ID token's optional claims in the app's Manifest.

Entra ID sends a person's address only once you add the `email` claim, and `xms_edov` says whether your tenant has verified the domain that address is in.  Without `email`, Riosoma can't link or make accounts.  Without `xms_edov`, it treats every Entra ID address as unverified, so the first sign-in of anyone not already linked is refused.

## Other OpenID Connect providers

1. In your provider, register a web application, often called a confidential client, that uses the authorization code flow, and add the callback address as a redirect URI.
2. Choose {{ui:sso.kind.oidc}} in Riosoma, and enter the {{ui:sso.field.issuer}} exactly as the provider publishes it.  It has to start with `https://`, and Riosoma reads the provider's settings from `/.well-known/openid-configuration` under it.
3. Enter the {{ui:sso.field.clientId}} and {{ui:sso.field.clientSecret}}.  Riosoma sends the secret in the request body when the provider supports that, and with HTTP Basic otherwise.
4. Make sure the provider's ID token includes `email`, with `email_verified` set to true for addresses it has checked.  Without them, Riosoma can't link or make accounts.

Choose {{ui:sso.test}} to check the issuer before you save.  "{{ui:sso.test.passed}}" means Riosoma found a working OpenID Connect provider there.  Otherwise it says what's wrong, such as "{{ui:sso.test.issuer}}"

Changing the issuer of a saved provider takes the client secret again, because Riosoma never sends a stored secret to a new address.

## What each setting does

| Setting | What it does |
|---|---|
| {{ui:sso.field.name}} | The provider's name on its sign-in button |
| {{ui:sso.field.issuer}} | Where the provider lives, for {{ui:sso.kind.oidc}}.  Riosoma fills in Google's and Microsoft's. |
| {{ui:sso.field.tenant}} | For Microsoft Entra ID, the tenant whose accounts can sign in, by its ID or one of its domains.  Empty accepts any work or school account. |
| {{ui:sso.field.clientId}} | The ID the provider gave Riosoma's app |
| {{ui:sso.field.clientSecret}} | The app's secret, stored encrypted and never shown again.  A saved provider says {{ui:sso.secret.stored}}, and {{ui:sso.secret.replace}} changes it. |
| {{ui:sso.field.domains}} | Email domains whose people can get new accounts, separated by commas.  Empty allows none. |
| {{ui:sso.field.autoCreate}} | Makes an account at the first sign-in for a verified address in those domains.  When it's off, people need an account before they sign in. |
| {{ui:sso.field.linkByEmail}} | Links a first sign-in to the existing account with the same verified address.  It starts on. |
| {{ui:sso.field.enabled}} | Shows the provider's button.  When it's off, nobody can sign in with the provider, and its settings are kept. |

## When sign-in fails

People see one of these messages on the sign-in page:

| Message | What it means |
|---|---|
| {{ui:sso.noAccount}} | Nothing linked or made an account.  Invite the person, or check the domains and the two account settings. |
| {{ui:sso.deactivated}} | The account is deactivated in {{ui:settings.nav.people}}. |
| {{ui:sso.state}} | They spent more than 10 minutes at the provider, or finished in a different browser. |
| {{ui:sso.denied}} | The provider refused the sign-in, or the person canceled it. |
| {{ui:sso.token}} | The provider's answer didn't check out.  Check the client ID and whether the secret has expired. |
| {{ui:sso.unavailable}} | The provider is off, or Riosoma couldn't reach its settings. |
| {{ui:sso.locked}} | Too many failed sign-ins from one network address, counting wrong passwords too. |

## Removing a provider

Choose {{ui:sso.delete}} in a provider's settings and confirm.  People who signed in with it keep their accounts, but lose their link to it.  They need another way to sign in, such as a password or an emailed link.  To pause a provider instead, turn off {{ui:sso.field.enabled}}.

Identity-provider discovery, token exchange, and signing-key requests follow the server’s private-host policy.  The server connects only to checked DNS addresses and refuses redirects.  An identity provider on a private network requires the operator’s existing private-host setting.
