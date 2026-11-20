---
id: knowledge-libraries
title: Knowledge libraries
summary: Give Rio reference documents to search when a question needs them.
area: rio
order: 11
level: simple
anchors: [libraries.title, libraries.personal, libraries.database, settings.knowledge]
related: [memory, similar-records, ai-footprint]
routes: [/settings/knowledge, /settings/*/knowledge, /admin/*/knowledge]
sections: [settings.knowledge=managing-knowledge-libraries]
---

## Managing knowledge libraries

Open {{ui:libraries.title}} under Settings → AI for organization and unit libraries, {{ui:libraries.database}} in database settings, or {{ui:libraries.personal}} in your personal settings.  Organization AI admins manage the organization library, unit AI admins manage their units, database creators and owners manage database libraries, and each person manages their own library.

Choose a {{ui:libraries.name}}, write a {{ui:libraries.description}} of up to 300 characters, choose a {{ui:libraries.classification}}, and select {{ui:libraries.save}}.  Rio sees a limited list of permitted library descriptions so it knows where to look.  It can list the remaining libraries when needed.  Documents are never included in every conversation.  Rio searches them only when a question calls for reference material and cites the document and section it used.

Use {{ui:libraries.file}} for a text-based PDF, Word (.docx), Markdown, plain text, or HTML document.  You can also fill in {{ui:libraries.documentName}} and {{ui:libraries.paste}}, then select {{ui:libraries.add}}.  Uploads pass through the installation’s virus scanner.  The library keeps the extracted text, and discards the original upload bytes once indexing has read them.  A scanner failure prevents ingestion.  Image-only PDFs need text recognition before uploading.

Drag one file from your desktop onto {{ui:libraries.dropDocument}}, check the selected filename, and select {{ui:libraries.add}}.  The same drop zone appears under {{ui:libraries.replaceFile}} for replacements.  The file picker remains available by keyboard and on phones.  Both methods accept the same formats and a maximum of 10 MB, with any lower library limit checked when saving.  A refused file explains the format, size, or single-file requirement before saving.

Adding or replacing a document answers as soon as the document is stored.  Reading and embedding continue in the background, and the document shows {{ui:libraries.statusIndexing}} until it is ready, blocked by data rules, or needs attention.  The list checks on it by itself, so there is no need to reload.  A closed browser tab or a slow connection doesn’t stop indexing once the upload has answered.  To stop it yourself, choose {{ui:libraries.stopIndexing}}.  A document that was already read keeps its text, so you can choose {{ui:libraries.reindex}} later, and one that was never read is removed.  {{ui:libraries.undo}} reverses a stop.

Indexing checks the library’s access, classification, and embedding settings again before each batch it sends, and once more before it saves.  If the person who started it can no longer manage the library, or the library’s classification no longer allows the provider, indexing stops there and the document says why.  If the server restarts, the queued work starts again from the beginning of the document.  A document that keeps failing to finish, or that takes longer than 15 minutes, reports that it needs attention.

The document list shows whether each document is ready, blocked by data rules, or needs attention.  Configure embeddings in the AI settings before indexing.  Use {{ui:libraries.reindex}} after fixing an embedding connection or changing its model.  {{ui:libraries.replaceFile}} replaces the source and rebuilds its passages.  {{ui:libraries.delete}} removes active passages immediately.  {{ui:libraries.undo}} reverses the last change if nobody has changed its target since.  Undo rebuilds embeddings using current access and data rules.  Private undo snapshots expire after 30 days and are removed by the hourly cleanup.  Deleting a person, database, or unit also deletes its libraries and undo snapshots.  A deleted unit’s library does not move to its parent.

Try {{ui:libraries.preview}} to see the passages a search retrieves.  Results contain their document, section, and a link to the document’s entry.  You only search libraries you can open.  A public classification does not make a library publicly accessible.

{{ui:libraries.guidance}} is different from a document.  It is an optional note of up to 1,000 characters for your organization or yourself, such as “Call our customers members.”  This guidance is included in every conversation when its classification permits the selected provider.  Put reference material in documents, and keep this note short.

Administrators set {{ui:libraries.limits}}.  Short sections share passages, and each document is limited to one passage per 1,000 allowed extracted characters, up to 500 passages.  Embedding uses batches of at most eight passages.  By default, each library accepts 100 documents, files up to 5 MB, and up to 100,000 extracted characters per document.  Public and internal libraries can use approved providers, confidential libraries use local providers, and restricted libraries are blocked from model requests.  These rules cover embedding, search results, descriptions, and guidance.  Organization and unit AI permissions also apply.

Embedding and search usage appear in the AI footprint.  Search power is optional and should come from a measurement.  Unknown power stays unknown.  Organization archives carry organization, unit, and database library definitions, organization guidance, and extracted document text, including eligible items still awaiting review.  Personal libraries, their documents, and personal guidance stay in their original organization, like private notes.  Vectors and undo history stay behind.  At the destination, approve each library before its documents in the import review.  If a library already exists for that scope, approval keeps its name and description and adds the imported documents to it.  It never loosens the library’s classification: the stricter of the two labels applies, and the archived guidance fills in only when the existing library has none.  A new archive carries those pending documents with the existing library.  A document still being read for the first time has no text yet, so archives leave it out.  Choose {{ui:organizationArchive.dismissKnowledge}} to permanently erase an unwanted pending item.  Dismissing a library also erases its pending documents, and a confirmation says how many before you choose {{ui:organizationArchive.dismissConfirm}}.  An archive imports only into an empty organization, so a dismissed item can’t come back later.  Document approval queues fresh embeddings with the destination’s settings, and the document shows its progress in its library.
