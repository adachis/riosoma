---
id: people-roles-and-lifecycle
title: People roles and account lifecycle
summary: Change roles, deactivate people, reactivate access, and transfer ownership.
area: administration
order: 15
level: standard
related: [profile, admin-roles-and-audit, scim-provisioning]
routes: [/settings/people, /settings/*/people, /admin/*/people]
anchors: [settings.people]
sections: [settings.people=find-a-person-and-change-their-role]
---

## Find a person and change their role

Open {{ui:settings.nav.people}} in {{ui:shell.nav.settings}}.  Use {{ui:people.filters.role}} and {{ui:people.filters.status}} to show owners, members, guests, active people, deactivated people, or invitations.  Counts show each status.  Filters stay in the address for bookmarking and browser Back.

Open the person's actions icon, then choose {{ui:people.actions.role}}.  Review what the selected {{ui:people.role.label}} permits before applying it.  Owners manage all administration areas.  Members can use organization-shared resources, subject to their resource permissions.  Guests see only resources shared with them by name and cannot administer the organization.

People administrators act only within their assigned reach.  Only owners can grant ownership or change another owner.  The last active owner cannot be demoted, deactivated, or removed.  Directory-managed roles and lifecycle change in the directory.

## Deactivate and reactivate

{{ui:people.actions.deactivate}} ends the person's sessions, API tokens, and connected apps immediately and prevents sign-in.  Their open tab explains that access ended.  Their shares, records, comments, and history stay, and their identity is marked deactivated.  Published automations keep running under their existing resource permissions, with {{ui:people.automations.continue}} visible to administrators.

{{ui:people.actions.reactivate}} allows sign-in again.  Ended sessions, tokens, and connected apps stay ended.  Role changes and lifecycle changes are audited.  The confirmation toast's {{ui:people.actions.undo}} restores the previous state only if it has not changed again and the current guards allow it.  Undo never restores credentials.

An account that also belongs to another organization cannot be deactivated, reactivated, or removed here.  This protects access in the other organization.

The same menu includes {{ui:auth.reset.admin}} and {{ui:auth.sessions.adminEnd}} for people within your reach.  Their existing confirmations and deep links still apply.

The existing {{ui:people.remove}} action is in the same menu for deactivated, directory-managed accounts.  Its confirmation explains that removal is permanent and transfers databases that only the removed person owned.  Use it to free a directory login name for another identity.

## Hand over ownership

An owner can use {{ui:people.actions.makeOwner}} to add an active owner.  {{ui:people.actions.transfer}} makes the other person an owner and makes the current owner a Member in one transaction.  Confirm with {{ui:people.transfer.password}} or a fresh second step.  Ownership transfer has no undo.

Each action has a deep link that opens its review dialog, with the same access checks as the menu.  Opening a link does not apply a change.  The role, status, transfer, and account-removal API routes use the same People scope and command checks.
