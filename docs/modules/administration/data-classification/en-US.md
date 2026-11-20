---
id: data-classification
title: Classifying your data
summary: Define labels that control how databases, tables, and fields may be shared and used.
area: administration
order: 15
level: advanced
related: [retention, org-units, export-and-import]
routes: [/settings/classification, /settings/*/classification, /admin/*/classification]
anchors: [settings.classification]
sections: [settings.classification=setting-classifications]
---

## Setting classifications

Owners and organization Security admins define labels in {{ui:shell.nav.settings}}, then {{ui:governance.classification}}.  Open [Data classification](/settings/classification) to manage up to 12 labels.

Choose {{ui:governance.addLabel}}, enter a name and description, choose a color, and select the rules.  Choose {{ui:settings.draft.save}} in the save bar at the bottom of the page to apply the change.  Names and descriptions are your own text.  Color is optional context—the name always identifies the label.

- {{ui:governance.noPublicLinks}} stops public views, embedded views, forms, calendar feeds, published pages, and public signature documents, including links created earlier.
- {{ui:governance.noExport}} stops downloads, attached files, reports, signature documents, and downloadable archives containing protected data.  It also blocks personal access token reads, Airtable-compatible API reads, SQL views, webhooks, and external actions in automations, routines, and scripts.
- {{ui:governance.noProviders}} keeps protected values out of provider inputs, including generated fields, semantic indexing, and AI steps in automations.  An automation AI step stops when its database, or any table or field in it, has this rule.
- {{ui:governance.noExternalSharing}} prevents sharing with guests, public access, and delivery to recipients outside the organization.  It also blocks personal access token reads, Airtable-compatible API reads, SQL views, webhooks, and external actions in automations, routines, and scripts.
- {{ui:governance.maskGuests}} hides protected fields from guests, including values calculated from those fields.  It also closes anonymous public views, embedded views, forms, sites, shared downloads, signature requests, and report emails to recipients outside the organization.  Member token reads, SQL views, webhooks, and member automation, routine, and script actions remain available unless another rule blocks them.

Under {{ui:governance.scope}}, choose a database.  Assign a label to the database, a table, or a field.  {{ui:governance.inherit}} uses the parent’s label.  A specific label replaces the inherited label.  Formulas, lookups, and other calculated values also retain their source fields’ restrictions.

Rules apply to owners as well as other people.  Existing public links are checked again when opened.  Conversation history prepared under an older classification policy is excluded from later provider inputs.

Joined fields retain restrictions from their source fields and every key used to match records, including through other joined tables.  Automation diagnosis also removes protected field choices and filter values before contacting a provider.

Use {{ui:governance.undo}} to reverse your last change.  Undo stops if someone has since changed the same policy.  A label in use cannot be removed until its assignments are cleared.  Changes are recorded in the audit log.

Snapshot restores, duplicates, and organization templates use the source database’s current assignments for databases, tables, and fields that still exist.  This also protects snapshots and templates saved before labels were assigned.  Assignments for objects that no longer exist come from the archive and require matching label rules in the destination organization.  Organization archives carry label definitions, assignments, retention policies, and legal holds together.

{{ui:governance.noExport}} closes token reads, downloads, and document delivery for signatures.  Internal snapshots, snapshot restoration, database duplication, and organization templates remain available and carry their classification.  Security admins can classify any database in the organization without receiving access to its records.
