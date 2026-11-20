---
id: signature-requests
title: Requesting electronic signatures
summary: Send a record's PDF for signatures, follow each person's progress, and keep the signed document with its audit trail.
area: databases
order: 34
level: standard
related: [attachments, fields, comments-and-history, field-and-record-permissions]
---

Riosoma's signatures are simple electronic signatures with an audit trail, not qualified or certificate-based signatures.  Each signer receives a private link and can sign without a Riosoma account.

## Send a request

Open a record's menu and choose {{ui:signatures.request.title}}.  You must be able to edit the record and its attachment field.  Restricted attachment fields cannot be shared for signing, and synced tables do not accept signature requests.

Choose a {{ui:signatures.request.document}} that has passed its file scan.  PDFs built on XFA forms can't be signed, so save one as a standard PDF first.  Add each signer's name and email address, then choose {{ui:signatures.request.parallel}} or {{ui:signatures.request.sequential}}.  Sequential requests follow the order of the signers in the list.

Use {{ui:signatures.placer.title}} to add a signature, initials, date signed, name, or text box.  Choose its signer and page, then click where it belongs.  Use {{ui:signatures.placer.add}} and {{ui:signatures.placer.adjust}} to position fields with the keyboard.  Fields can't overlap, so no one's answer can cover another's.  Every signer needs at least one signature field.

Add a {{ui:signatures.request.message}} and an optional {{ui:signatures.request.due}}.  Without a due date, links expire after 30 days.  Optionally choose a status field and completion date field to update when everyone has signed.  Choose {{ui:signatures.request.send}} to email the signers who are ready to sign.

Each person can send 20 requests an hour and add 200 signers a day, unless the server's administrator set other limits.

## Sign a document

Attached files inside a PDF are removed before signing.

Open the private link in your email and review the PDF.  The page shows every field placed on the document.  Your own fields are numbered, and other signers' fields are outlined and labeled with their names, for the people who will fill them in.  The page shows the other signers' names and whether they have signed, but not their email addresses or answers.

Follow your fields with {{ui:signatures.sign.next}}.  Draw a signature, type your name, or use {{ui:signatures.sign.upload}}.  Typed signatures use the script font already included with Riosoma.  A text box holds up to 500 characters, and the text is wrapped and sized to fit the box it was placed in.  Complete every assigned field, read and accept the electronic signing agreement, and choose {{ui:signatures.sign.finish}}.  The agreement's exact wording is recorded with your signature.  The date signed is the date in your own time zone, with the zone's abbreviation beside it.

To refuse, choose {{ui:signatures.sign.decline}}, enter a reason, and choose {{ui:signatures.sign.confirmDecline}}.  Declining ends the request and voids its links.

## Follow progress

The record's {{ui:signatures.history.tab}} tab lists requests, signer progress, and {{ui:signatures.history.events}}.  Only people who can edit the record see it.  The requester can use {{ui:signatures.history.remind}} once every 24 hours per signer.  Requests with due dates receive an automatic reminder during the three days before they expire.  A signer waiting for their turn receives an invitation when the previous signer finishes.

Use {{ui:signatures.history.cancel}} and confirm to void all remaining links.  Removing the source attachment from the record also cancels an open request.  A used, expired, or canceled signing link cannot be reused.

If the source document's contents change, or the signed PDF can't be made, the request shows {{ui:signatures.state.failed}}, its links stop working, and the requester gets an email.  Send a new request.  An email that can't be delivered is tried 10 times.  After that, the history shows {{ui:signatures.event.undelivered}} and the requester is told.

## The completed PDF

After the last signature, Riosoma removes scripts and automatic actions from the document and draws any form fields into their pages as they appear, so nothing in the signed copy can still be edited.  It then stamps every field onto the original pages, each inside the box it was placed in, and appends a certificate.  The certificate records each signer's name, email, signing time in UTC, time zone, IP address, browser information, and consent wording.  Long certificates continue onto additional pages.

The certificate includes the original document's SHA-256, which matches the source attachment on the record.  A PDF can't hold the hash of all its own bytes, because adding the hash changes them, so the signed PDF's own SHA-256 appears in the completion email and in {{ui:signatures.history.events}}.

The signed PDF becomes a new attachment on the record and follows the normal file scanning process.  Every signer and the requester receive it by email after it passes scanning.  A signed PDF too large to attach arrives as a download link that works for 30 days.  The original attachment remains in the record.  Completion updates the chosen fields through the requester's current permissions, so permission changes can stop the request.

## The audit trail

Every step of a request is kept in the organization's audit log, which can't be changed or deleted.  Signers have no Riosoma account, so their steps name no person.  They record the signer, the IP address and browser they used, and, for a signature, a fingerprint of the consent wording they accepted.  The audit log is the record of truth.  The history on the record is a convenient view of the same steps, and it goes when the table is deleted.
