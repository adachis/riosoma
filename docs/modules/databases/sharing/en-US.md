---
id: sharing
title: Sharing a database
summary: Choose who can open a database and what each person can do in it.
area: databases
order: 4
level: simple
related: [together, field-and-record-permissions, public-view-links, org-units]
anchors: [database.share, share.add, share.people, share.role, share.everyone, share.dialog]
demo: sharing
sections: [database.share=adding-people, share.people=adding-people, share.role=roles, share.dialog=adding-people]
---

A database you make is yours until you share it.  Choose {{ui:database.share}} at the top of the database to see who can open it and to add people.  Only its owners can change who has access.

## Adding people

In {{ui:share.add}}, type part of a name or an email address, then choose the person from the list.  They're added straight away as an {{ui:share.role.editor}}, and the list shows them with everyone else who has access.  Change a person's role beside their name, or remove them with the button at the end of their row.

## Inviting someone new

In {{ui:share.add}}, enter a complete email address.  If your organization's policy allows it, the address shows {{ui:share.invite.pending}}.  Choose {{ui:share.invite.access}}, then {{ui:share.invite.add}}.  The person receives one invitation describing who shared the item.  Creating an account uses the invited address, or the person accepts through the organization's matching single sign-on provider.  Access starts only when they accept, and they land on the shared item.

Several shares to the same pending address use one live invitation and grant all those items on acceptance.  Each new share or resend replaces the previous link.  Links expire after seven days.  Pending people show {{ui:share.invite.invited}} with their access, {{ui:share.invite.resend}}, and {{ui:share.invite.revoke}}.  Revoking a pending share removes that item's pending access.  Removing an invitation from {{ui:settings.nav.people}} removes every pending share attached to it.

If sharing with new people is off, the field explains who can invite people.  If domains are restricted, it names the allowed domains.  An invalid address shows a field message.  When email is not configured, {{ui:share.invite.link}} and {{ui:share.invite.copy}} let you send the invitation yourself.  Copyable links combine only items you can manage.  Other owners' pending shares and imported invitations keep their original links, and require separate acceptance.  A copied link creates the account for a new person and signs them in.  If the address already has an account, the link signs nobody in: the person signs in to that account first, then opens the link to accept the share.

## Roles

| Role | What it allows |
|---|---|
| {{ui:share.role.owner}} | {{ui:share.role.owner.detail}} |
| {{ui:share.role.creator}} | {{ui:share.role.creator.detail}} |
| {{ui:share.role.editor}} | {{ui:share.role.editor.detail}} |
| {{ui:share.role.commenter}} | {{ui:share.role.commenter.detail}} |
| {{ui:share.role.reader}} | {{ui:share.role.reader.detail}} |

## Everyone in your organization

The last row of the list gives everyone in your organization one role at once.  Choose {{ui:share.noAccess}} there to keep the database to the people listed above it.

To go further, {{doc:field-and-record-permissions}} hides fields and records from some roles, and {{doc:public-view-links}} shares a single view with people outside Riosoma.
