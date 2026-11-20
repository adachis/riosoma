---
id: admin-roles-and-audit
title: Admin roles, policy presets, and the audit log
summary: Assign organization admin roles, review preset changes, and search or export the audit log.
area: administration
order: 16
level: advanced
related: [org-units, sign-in-policy]
routes: [/settings/audit, /settings/*/audit, /admin/*/audit]
anchors: [settings.audit]
sections: [settings.audit=read-and-export-the-audit-log]
---

## Assign organization roles

Only the organization's owner can assign organization admin roles.  Open {{ui:settings.nav.people}} in {{ui:shell.nav.settings}}, then choose {{ui:adminRoles.title}} in the member's actions menu.  Check any combination of the six areas, then choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  Clearing every area removes those organization roles.  Guests and owners do not need this editor.

Each change is audited, and the member receives an email and a bell notification.  {{ui:adminRoles.undo}} restores the previous roles if they have not changed again.  Unit roles continue to be managed in {{ui:settings.nav.orgUnits}}.

The role editor has a deep link in the address.  It can be bookmarked or shared with the owner.  Opening the link never grants access by itself.

## Apply a policy preset

The owner and organization Security admins can use {{ui:organizationPresets.title}} in {{ui:mfa.nav.security}}.  Choose {{ui:orgUnits.preset.open}}, {{ui:orgUnits.preset.balanced}}, {{ui:orgUnits.preset.strict}}, or {{ui:orgUnits.preset.regulated}} under {{ui:organizationPresets.choose}}.

Review every setting's {{ui:organizationPresets.before}} and {{ui:organizationPresets.after}} values, then choose {{ui:organizationPresets.apply}} to stage them.  Choose {{ui:settings.draft.save}} in the bottom bar to store those values, or {{ui:settings.draft.discard}} to cancel.  Saved values are independent of the preset, and settings it leaves out stay as they are.  The server's session limits still apply.  Regulated requires an enabled single sign-on provider before it can be applied.

If settings changed after the preview loaded, refresh the preview before trying again.  {{ui:adminRoles.undo}} restores the previous values only while the settings still match the applied change.

## Read and export the audit log

The owner and organization Audit admins can open {{ui:settings.nav.audit}}.  Other admin areas do not grant access, because older events do not reliably identify their administration area.

Use {{ui:audit.search}}, {{ui:audit.person}}, {{ui:audit.action}}, {{ui:audit.resource}}, and the UTC time range, then choose {{ui:audit.filter}}.  Person accepts a name, email address, or person ID.  Resource matches a target or a resource ID recorded with an event.  The time range includes both endpoints.

Enter keeps you in the filter field.  Choose {{ui:audit.filter}} to apply your filters.  Text filters allow up to 200 characters, and the end time must be at or after the start time.  Invalid filters stay in their fields with an error so you can correct them.  {{ui:audit.clear}} removes the filters and their errors.

Open an event for {{ui:audit.detail}}.  Its address keeps the filters, selected event, and page, so bookmarks and browser Back return to the same view.  {{ui:audit.exportCsv}} and {{ui:audit.exportJson}} stream all matching events, including older pages.  Each export request creates its own audit event.  CSV protects text that a spreadsheet might interpret as a formula.

## Check integrity

{{ui:audit.integrity}} checks the entire organization's log, regardless of the displayed filters.  Each event includes its preceding hash and a SHA-256 hash of its canonical stored fields.  Existing history is chained during the upgrade, and concurrent inserts are ordered within each organization.

The result reports the first broken event, with a link to its details.  Database triggers refuse ordinary updates and deletions.  The chain detects changes and missing entries within retained history, but it is not an external signature that could prove history against someone who can replace the entire database.

A retention window can expire events, as [Retention](/settings/retention) explains.  An expired event leaves its place in the chain and its hash behind, and the events that stay keep their own hashes, so an integrity check still walks an unbroken chain and an export taken earlier still matches them.
