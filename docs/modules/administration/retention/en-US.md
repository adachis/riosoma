---
id: retention
title: Setting retention and legal holds
summary: Choose how long data is kept and pause purging for a database under legal hold.
area: administration
order: 16
level: advanced
related: [data-classification, org-units, export-and-import]
routes: [/settings/retention, /settings/*/retention, /admin/*/retention]
anchors: [settings.retention]
sections: [settings.retention=choosing-retention-periods]
---

## Choosing retention periods

Owners and organization Security admins set retention in {{ui:shell.nav.settings}}, then {{ui:governance.retention}}.  Open [Retention](/settings/retention), then use {{ui:governance.scope}} to choose the organization or any database in the organization.  Security administration does not grant access to its records.

Set a window for {{ui:governance.trashDays}}, {{ui:governance.historyDays}}, {{ui:governance.deletedCommentsDays}}, {{ui:governance.automationRunsDays}}, {{ui:governance.routineRunsDays}}, and {{ui:governance.auditDays}}.  Choose {{ui:governance.days}} and enter a number, or choose {{ui:governance.forever}}.  Database settings can use {{ui:governance.organizationDefault}}.

The defaults keep trash and comments on deleted records for 30 days, automation run logs for 30 days, routine run logs for 90 days, and record history and audit events indefinitely.  A database audit window can only extend its organization’s window.  Audit events have a minimum of 365 days.  The regulated org-unit preset raises the audit minimum to 2,555 days when that override is allowed.  The longest applicable unit minimum protects the organization’s events.

Choose {{ui:settings.draft.save}} in the save bar at the bottom of the page to save.  Expiration runs in batches.  Each purge records counts in the audit log without copying removed contents.  Shortening a window can make existing data eligible for removal at the next pass.  Expired record history also loses its undo actions.

Source sync runs and their record changes expire at the shorter of {{ui:governance.historyDays}} and the table’s source-history window, which defaults to 90 days.  The hourly retention pass performs this cleanup, and a legal hold protects it.  At {{ui:governance.trashDays}}, a synced table’s records, fields, attachments, views, and physical storage are removed.  Only metadata needed for retained sync history remains until that history expires in counted batches.  Metadata cannot be restored, even if the trash window is later extended.  Abandoned sync runs on trashed tables become eligible for expiration after their 30-minute lease ends.  Queued, waiting, and running automation executions stop when their automation is purged, and their logs follow {{ui:governance.automationRunsDays}}.  Local history, comments, and run logs follow their own windows independently of trash, including after their database has been purged.  Those rows keep the effective windows in place when the database was purged.

Home shortcuts and tags use the organization’s trash window.  The trash window is the one the app names: delete confirmations and the countdown in the trash both follow it, and a window with no limit, or a hold, says that deleted things are kept rather than naming days.

An expired audit event leaves its place in the chain and its hash behind, so {{ui:audit.integrity}} still walks an unbroken chain and still finds an event that went missing any other way.  Purging never rewrites the events that stay, so an export you already took still matches them.

For a database, turn on {{ui:governance.legalHold}} to stop its purging.  Held trash remains available, and retained history, comments, and run logs stay in place.  Removing a hold makes overdue data eligible again.

{{ui:governance.undo}} can restore a policy if it has not changed since your action.  It cannot recover contents already purged.  Every policy and hold change has an audit event.
