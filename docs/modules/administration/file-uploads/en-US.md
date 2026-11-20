---
id: file-uploads
title: File uploads
summary: Set upload limits, control file checks, and detect, test, and control virus scanning.
area: administration
order: 8
level: standard
related: [credential-vaults]
routes: [/settings/files, /settings/*/files, /admin/*/files]
anchors: [settings.files]
sections: [settings.files=virus-scanning]
---

The owner and Security administrators open {{ui:shell.nav.settings}} → {{ui:files.settings.title}}.  Open `/settings/files` to return directly.

Leave {{ui:files.settings.maxUploadBytes}} blank for no cap, the default.  To set a cap, enter a positive whole number of bytes and choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  Changes are recorded in the audit log.

Refreshed settings update the input until you edit it.  Unsaved edits stay in place during refreshes and saves, including when the saved cap drops leading zeros.  The saved message applies to the submitted cap, so a later edit needs another save.

If another administrator saves a different cap first, your save keeps your draft and shows {{ui:settings.draft.conflict}}.  Choose {{ui:settings.draft.reload}} to review the current cap before editing and saving again.

The cap applies to attachment uploads, including resumable uploads, files copied from cloud drives, and attachments imported by address.  It applies equally to PostgreSQL, local volumes, S3-compatible storage, and Azure Blob Storage.  Other import operations may have their own stricter limits.  Your storage service and reverse proxy can also impose limits.

Import reports identify attachments rejected by the organization cap as too large and show the effective file limit.

Reducing the cap stops an unfinished upload larger than the new cap on its next chunk.  Already completed files remain available.  Raise or clear the cap to resume a blocked upload.  Failed chunks leave the committed upload offset unchanged.

## Virus scanning

Open `/settings/files#virus-scanning` for a direct link.  {{ui:files.scanner.description}}

Choose {{ui:files.scanner.detect}} to look for the Compose sidecar, a configured address, or a common local socket.  You can enter an address approved by the server operator in {{ui:files.scanner.address}}.  The operator approves additional destinations through `RIOSOMA_CLAMAV_APPROVED_URLS` or `RIOSOMA_CLAMAV_URL` and restarts the server.  Administrators can select only approved destinations.  {{ui:files.scanner.test}} sends the harmless EICAR test signature from memory over INSTREAM without storing a test file.  Detection performs this test too.  {{ui:files.scanner.enable}} repeats the test before enabling scanning, with one click.  The controls show whether the daemon is reachable, its signature date when reported, and its last error.  Only owners and organization Security administrators can use these controls.  Tests and changes are audited.  Follow the linked ClamAV installation instructions when no daemon is found.

The bundled scanner no longer has a 1 GiB stream limit.  ClamAV cannot scan a whole file of 2 GiB or more, and configured daemons can have lower limits.  A limit rejection shows {{ui:files.tooLargeToScan}}.  The default keeps the file quarantined.  Choose {{ui:files.scanner.allowOversized}} to allow downloads while retaining {{ui:files.tooLargeAllowed}}.  These files are never called clean, previewed, published, or exported.  Turn the setting off to revoke access, even during a scanner outage.  Policy changes use the active scanner address and leave unsaved address edits alone.  Enabling scanning or changing its active address requires a successful test.  Changing the scanner address requeues pending and oversized files, while archive attachments imported without contents stay unavailable.  A clean verdict requires all stored bytes to match the attachment size.

{{ui:files.scanner.disable}} stops scanning new uploads, and pending files stay in quarantine.

## File checks

{{ui:files.checks.description}}  The shared file checks run before knowledge library uploads, profile pictures, image search previews, signature images, spreadsheet imports, and document imports are opened.  An enabled scanner must approve a complete file before it is parsed.  If that scanner is unreachable or its address is not approved, these callers refuse the file.

Open {{ui:files.checks.outside}} to choose {{ui:files.checks.requireScanner}}, the default, or {{ui:files.checks.builtInOnly}}.  {{ui:files.checks.outsideHelp}}  Owners and organization Security administrators can change this setting, and changes are audited.  Demo mode refuses changes.

{{ui:files.checks.allowMacros}} controls Office macros in outside files.  {{ui:files.checks.macrosHelp}}  Password-protected files are held so the caller can ask a person for an unprotected copy.  Archive checks limit the expansion ratio to 100, the total member count to 1,000, nesting to three archives, and total expanded contents to 64 MiB.  ZIP, TAR, and GZIP containers are checked, including older TAR archives and their nested contents.  Office content types and relationships identify macro parts even when their filenames change.  Other archive formats are held because their expansion cannot be checked.  PDF inspection runs in a separate worker with a five-second deadline, a 10 MiB input limit, a 4 MiB decoded stream limit, and a 16 MiB total decoding limit.  Files that exceed these limits are held.  Active content in a PDF, and scripts in a web page, are noted without blocking the file.  A file's name or stated type counts as mismatched only when it names a different kind of file: one kind of text labeled as another is accepted, as is a CSV that Windows labels as an Excel file.

CSV and spreadsheet exports prefix formula-like text beginning with `=`, `+`, `-`, or `@` with an apostrophe, so exported values stay text.
