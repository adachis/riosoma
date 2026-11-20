---
id: saml-single-sign-on
title: Setting up SAML single sign-on
summary: Let people sign in with Okta, Microsoft Entra ID, Google Workspace, or another SAML 2.0 identity provider.
area: administration
order: 2
level: advanced
related: [single-sign-on, sign-in, sign-in-policy]
---

Many organizations connect their apps to an identity provider with SAML 2.0.  A SAML provider adds a button to the sign-in page like any other kind of single sign-on, and the same settings decide who gets an account.  {{doc:single-sign-on}} explains those settings, and this article covers what's different about SAML.

The organization's owner sets it up in {{ui:shell.nav.settings}}, then {{ui:settings.nav.sso}}.  Choose {{ui:sso.add}}, then {{ui:sso.saml.kind}}.  Only an owner adds a provider, changes its {{ui:sso.saml.field.entityId}}, {{ui:sso.saml.field.ssoUrl}}, or {{ui:sso.saml.field.certificates}}, or turns on {{ui:sso.saml.field.verifiesEmails}} or {{ui:sso.field.linkByEmail}}.  Admins given the Security role can change a provider's other settings, turn those two off, and delete it.  They see the identity provider's details without being able to edit them.

## Riosoma's details

The form starts with {{ui:sso.saml.riosoma.title}}, the two values your identity provider asks for.  Each has {{ui:sso.copy}} beside it:

| Field | What identity providers call it |
|---|---|
| {{ui:sso.saml.riosoma.entityId}} | Audience URI, Identifier, or SP entity ID |
| {{ui:sso.saml.riosoma.acsUrl}} | Single sign-on URL, Reply URL, or ACS URL |

They look like this, with an ID that's different for every provider:

```
https://riosoma.example.com/api/auth/saml/Ab12Cd34Ef56Gh78/metadata
https://riosoma.example.com/api/auth/saml/Ab12Cd34Ef56Gh78/acs
```

Choose {{ui:sso.saml.riosoma.download}} for an identity provider that takes a metadata file instead.  Once the provider is saved, the entity ID is also the address of that metadata, for identity providers that read it from a URL.

The ID is set when you first choose {{ui:sso.saml.kind}}, so you can copy the values, set up the identity provider in another tab, and come back to finish.  Closing the dialog keeps the same ID until you save a SAML provider or reload the page.  Like the callback address for other kinds, the values use `RIOSOMA_BASE_URL` when the server has one.

## The identity provider's details

Under {{ui:sso.saml.idp.title}}, paste the identity provider's metadata address, or the metadata itself, into {{ui:sso.saml.metadata.source}} and choose {{ui:sso.saml.metadata.load}}.  Riosoma fills in {{ui:sso.saml.field.entityId}}, {{ui:sso.saml.field.ssoUrl}}, and {{ui:sso.saml.field.certificates}}, and lists each certificate with its expiry date.  You can also type all three by hand.

Riosoma reads a metadata address once, when you choose {{ui:sso.saml.metadata.load}}, and never checks it again.  The address has to start with `https://` and be on the public internet.  For an identity provider on a private network, paste its metadata instead, or have the server's operator set `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true`.

Identity providers replace their signing certificates every few years.  Before a certificate expires, load the metadata again, or add the new certificate beside the old one in {{ui:sso.saml.field.certificates}}.  Riosoma accepts a signature from any certificate listed there.

## Email addresses

Riosoma reads a person's address from an attribute named `email` or `mail`, or Microsoft's `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`.  Without one, it uses the NameID when its format is an email address.

An address counts as verified only when {{ui:sso.saml.field.verifiesEmails}} is on.  Turn it on when the identity provider only sends addresses it knows people own, as Okta, Microsoft Entra ID, and Google Workspace do for accounts an administrator manages.  Until it's on, a first sign-in can't link to an existing account or make a new one.

## Okta

1. In the Okta Admin Console, open Applications, choose Create App Integration, choose SAML 2.0, and give the app a name.
2. Paste the {{ui:sso.saml.riosoma.acsUrl}} into Single sign-on URL, and the {{ui:sso.saml.riosoma.entityId}} into Audience URI (SP Entity ID).
3. Set Name ID format to EmailAddress and Application username to Email.  To give new accounts a name, add the attribute statements `firstName` and `lastName` with the values `user.firstName` and `user.lastName`.
4. Finish, then open the app's Sign On tab and copy its Metadata URL into {{ui:sso.saml.metadata.source}}.
5. Assign the app to the people or groups who should use it.

## Microsoft Entra ID

1. In the Microsoft Entra admin center, open Enterprise applications, choose New application, then Create your own application.  Name it and choose to integrate an application you don't find in the gallery.
2. Open Single sign-on and choose SAML.
3. Under Basic SAML Configuration, choose Edit.  Add the {{ui:sso.saml.riosoma.entityId}} as the Identifier (Entity ID) and the {{ui:sso.saml.riosoma.acsUrl}} as the Reply URL, then save.
4. Under SAML Certificates, copy the App Federation Metadata Url into {{ui:sso.saml.metadata.source}}.
5. Under Users and groups, assign the people or groups who should use it.

Entra ID sends the email address claim by default, and signs the assertion, which is all Riosoma needs.

## Google Workspace

1. In the Google Admin console, open Apps, then Web and mobile apps.  Choose Add app, then Add custom SAML app, and give it a name.
2. On the Google Identity Provider details page, choose Download metadata.  Open the file and paste all of it into {{ui:sso.saml.metadata.source}}.
3. On the Service provider details page, paste the {{ui:sso.saml.riosoma.acsUrl}} into ACS URL and the {{ui:sso.saml.riosoma.entityId}} into Entity ID.  Set Name ID format to EMAIL and Name ID to Primary email.
4. To give new accounts a name, map First name to `firstName` and Last name to `lastName` under Attribute mapping.
5. Finish, then turn the app on for everyone, or for the organizational units or groups who should use it.

## How Riosoma checks a sign-in

Sign-in always starts at Riosoma.  Riosoma sends the identity provider a request, remembers it in a short-lived cookie in that browser, and accepts only an answer to that request, from that browser, within 10 minutes.  It refuses an answer when:

- Neither the response nor the assertion is signed with one of the provider's certificates, or any signature it carries doesn't check out
- It's meant for another audience or another Assertion Consumer Service URL, or comes from another entity ID
- Its time limits have passed, allowing three minutes for clocks that disagree
- The same assertion was already used to sign in
- Its NameID is transient, since that changes at every sign-in and can't say who someone is
- The assertion is encrypted, which Riosoma doesn't support, so leave assertion encryption off

Starting from the identity provider's own app dashboard doesn't work, because Riosoma didn't send a request for that sign-in.  Where the identity provider lets you set a sign-on or start address for the app, use Riosoma's sign-in page.

## Who a person is

Riosoma recognizes people by the identity provider's entity ID together with the NameID, never by email alone.  Use a NameID that stays the same for a person, such as a persistent ID or their email address.  If you change a provider's {{ui:sso.saml.field.entityId}}, Riosoma treats it as a new identity provider, and people link again by email on their next sign-in.

Single sign-on skips the second step that {{doc:sign-in-policy}} can require after a password, because the identity provider handles that part.

## When sign-in fails

People see the same messages as with other kinds of single sign-on.  For SAML, these usually mean:

| Message | What to check |
|---|---|
| {{ui:sso.state}} | The sign-in took more than 10 minutes, finished in a different browser, or started at the identity provider's dashboard. |
| {{ui:sso.token}} | The identity provider signed with a certificate Riosoma doesn't have, sent the answer to a different entity ID or URL, or its clock is more than three minutes off. |
| {{ui:sso.denied}} | The identity provider refused the sign-in, often because the person isn't assigned to the app. |
| {{ui:sso.noAccount}} | Nothing linked or made an account.  Check {{ui:sso.saml.field.verifiesEmails}}, the domains, and the two account settings. |
