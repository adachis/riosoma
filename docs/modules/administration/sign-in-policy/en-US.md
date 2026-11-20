---
id: sign-in-policy
title: Requiring a second step to sign in
summary: Choose who must use a passkey or an authenticator app after a password, and reset second steps for someone who has lost theirs.
area: administration
order: 3
level: advanced
related: [passkeys-and-two-step-sign-in, single-sign-on, sign-in]
routes: [/settings/sign-in-policy, /settings/*/sign-in-policy, /admin/*/sign-in-policy]
anchors: [settings.sign.in.policy]
sections: [settings.sign.in.policy=sharing-with-new-people]
---

The sign-in policy decides who must have a second step, a passkey or an authenticator app, to sign in with a password, an emailed link, or an invitation.  The organization's owners, and admins given the Security role, set it in {{ui:shell.nav.settings}}, then {{ui:mfa.nav.policy}}.

Under {{ui:mfa.policy.label}}, choose one, then choose {{ui:settings.draft.save}} in the save bar at the bottom of the page:

| Choice | Who must have a second step |
|---|---|
| {{ui:mfa.policy.off}} | Nobody.  Anyone can add one in {{ui:mfa.nav.security}}. |
| {{ui:mfa.policy.admins}} | Owners, and members with any admin role |
| {{ui:mfa.policy.everyone}} | Every member and guest |

The policy starts as {{ui:mfa.policy.off}}.

## Sharing with new people

Under {{ui:share.policy.title}}, set {{ui:orgUnits.policy.newPeopleSharing}}, {{ui:orgUnits.policy.newPeopleRole}}, and {{ui:orgUnits.policy.newPeopleAdministratorsOnly}}.  New people join as guests by default.  Guests receive the items shared with them, and members also receive organization-wide access.  Save with {{ui:settings.draft.save}}, or use {{ui:settings.draft.discard}} to abandon changes.

{{ui:orgUnits.policy.allowedEmailDomains}} accepts a comma-separated list.  An empty list allows every domain.  Matching ignores case and requires the whole domain to match.  A subdomain is allowed only when listed separately.  This restriction also applies to invitations from {{ui:settings.nav.people}}.  Units inherit these values and can override the settings permitted by the organization, following each setting's policy rule.

The Open preset allows item owners to invite guests.  Balanced limits new-person sharing to People administrators.  Strict and Regulated turn new-person sharing off.  Invitations expire after seven days, and removing an invitation removes its pending item access.  Invitations and pending shares are audited.  Pending shares are deliberately excluded from organization archives and require fresh sharing at the destination.

## How it applies

- Anyone who has a second step is asked for it after a password or an emailed link, whatever the policy says.  The policy only decides who has to have one.
- Someone who must have one and doesn't sees {{ui:mfa.enroll.title}} the next time they sign in, and can't reach anything else until they add a passkey or an authenticator app.  Adding one finishes signing in and shows their recovery codes.
- A new policy applies at each person's next sign-in.  Sessions already open keep working until they end.
- A passkey sign-in counts as both steps, since the device has already checked who's holding it.
- Sign-ins through single sign-on skip Riosoma's second step and leave it to the identity provider.  To require one for those, set it up there, such as with conditional access in Microsoft Entra ID or 2-Step Verification in Google Workspace.

The second step has to be finished within 10 minutes of the password or link.  Failed codes count toward the same limits as wrong passwords: 10 failed sign-ins to one account within 15 minutes pause sign-ins to that account, and 100 from one network address pause sign-ins from that address.  An authenticator code is accepted during its own 30-second window and the one on either side, to allow for a phone's clock running a little off, and each code works once.

## Passkeys need a secure address

A passkey belongs to the host name of the server's public address: `RIOSOMA_BASE_URL` when it's set, and otherwise the address saved when the server was set up.  That address has to use https, or plain http on `localhost`, and its host has to be a domain name rather than an IP address.  Otherwise nobody can add or use passkeys, the sign-in page doesn't offer them, and {{ui:mfa.nav.security}} says "{{ui:mfa.settings.passkeysOff}}"  Authenticator apps and recovery codes work either way.

Browsers bind each passkey to the host name it was made for, so moving the server to a new host name stops existing passkeys from working.  People can still sign in with a password and their authenticator app or a recovery code, then add new passkeys.  Anyone whose only second step was a passkey needs a recovery code, or a reset.

## Resetting someone's second steps

When someone has lost their passkeys, their authenticator app, and their recovery codes, reset their second steps.  In {{ui:settings.nav.people}}, choose {{ui:mfa.people.reset}} beside them, then {{ui:mfa.people.confirm}}.  Their passkeys, authenticator app, and recovery codes stop working right away.  If the policy requires a second step of them, they add a new one the next time they sign in.

- The button shows for owners, and for admins with the Security role, on the {{ui:settings.nav.people}} page, which also needs the People role.
- Only an owner can reset another owner's second steps.
- Nobody resets their own here.  People change their own in {{ui:mfa.nav.security}}, which asks them to confirm it's them first.
- Resetting doesn't end sessions that are already open.
- Administrators can take second steps away but never see them.  Riosoma keeps only a passkey's public key, seals each authenticator app's secret with the server's key, and keeps recovery codes hashed like passwords, so none of them can be shown to anyone.

## Password reset and recovery

{{ui:auth.reset.policyEnable}} controls password reset for the organization.  Turning it off stops existing reset links working and tells people to contact an administrator.  It does not change second-step requirements.  You can bookmark `/admin/security/sign-in-policy/password-reset`.

Administrators with People access can open a person under {{ui:settings.nav.people}}, choose {{ui:auth.reset.admin}}, and send a reset email or choose {{ui:auth.reset.create}}.  {{ui:auth.reset.copy}} copies the one-time link.  Share it privately with the person.  Creating a link replaces earlier reset links.  It does not change the password or end sessions until the person uses it.  {{ui:auth.sessions.adminEnd}} ends all of that person’s sessions immediately.  Unit administrators can act only on the people their People scope reaches.  Only owners can act on another owner.  Only owners can create a one-time link for a person who holds administration roles, in the organization or in a unit, because whoever holds the link can sign in as that person.  Other administrators can still end that person’s sessions, and can send them a reset email when the server sends email.  On a server without email, ask an owner to create the link.

### Recovering the only owner from the server

If email is unavailable and the only active owner cannot sign in, the server operator can open an interactive shell on the server, load the same configuration and database settings as the running server, and run:

```sh
node apps/server/dist/tools/password-reset.js owner-email-address
```

Replace `owner-email-address` with the owner’s email address.  In a container, open its shell with an interactive terminal first, then run the command inside it.  The server’s public address must be configured.  The command has no HTTP endpoint, refuses noninteractive input, and works only for an organization’s sole active owner who can use a password.  It prints a one-time reset link and records its creation in the audit log without the link or token.  This emergency path can recover the sole owner even when the organization has turned ordinary password reset off.

Open the printed link and choose a new password within 30 minutes.  Using it ends all earlier sessions.  Sign in fresh afterward with the account’s usual second step.  The command does not remove an authenticator app, passkey, or recovery code requirement.  Keep the printed link private, and close the terminal after using it.
