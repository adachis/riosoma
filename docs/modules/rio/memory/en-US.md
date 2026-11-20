---
id: memory
title: Saved memories
summary: Keep short notes for yourself or everyone in a database.
area: rio
order: 10
level: simple
anchors: [knowledge.myMemories, knowledge.databaseMemories, settings.memories]
related: [asking-rio, similar-records]
routes: [/settings/memories, /settings/*/memories, /admin/*/memories]
sections: [settings.memories=managing-memories]
---

## Managing memories

Open {{ui:knowledge.myMemories}} in Settings, choose a {{ui:knowledge.database}}, and use {{ui:knowledge.addNote}} to keep a short note.  You can edit a note with {{ui:knowledge.save}}, remove it with {{ui:knowledge.delete}}, or reverse the last change with {{ui:knowledge.undo}}.

Personal notes are private to you and stay in the database you chose.  Shared notes live under {{ui:knowledge.databaseMemories}} in database settings.  Anyone who can open that database can read shared notes, and creators can edit them.  Notes never move between databases or organizations.

Ask to remember or forget a note during a conversation in a database.  Relevant notes are recalled on later turns in that database.  If the embedding service is unavailable, recall uses matching words and recent notes after checking access again.  Notes provide context, and cannot grant access or override your instructions.

Administrators can turn off {{ui:knowledge.memoryEnabled}}.  Saved notes remain available to review, edit, and delete, but conversations stop saving or recalling them.  Notes are excluded from organization archives.
