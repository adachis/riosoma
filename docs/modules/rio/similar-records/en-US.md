---
id: similar-records
title: Find similar records
summary: Search enabled tables by the meaning of their text.
area: rio
order: 12
level: advanced
anchors: [knowledge.similar, knowledge.embeddings]
related: [memory, web-search, ai-footprint]
---

Choose {{ui:knowledge.similar}} from database settings or a record's menu.  Pick a {{ui:knowledge.table}}, enter what you want to find, and choose {{ui:knowledge.find}}.  Open a result to see its record.  The address keeps your table and search text so you can return to the search.

An administrator first turns on {{ui:knowledge.embeddingEnabled}} and chooses an {{ui:knowledge.provider}}, a small {{ui:knowledge.model}}, and its API base address.  The compatible format appends an embeddings endpoint.  The local format uses the local embedding API.  Existing provider credentials are reused only when the base address is the provider's own.  For a provider whose endpoint your organization set, that means the saved endpoint or an address under it.  Otherwise it means the provider's own host.  They are never sent anywhere else.

Only tables explicitly enabled with {{ui:knowledge.indexTable}} are indexed.  Text fields are processed in small batches as records change.  Edits are queued separately so they do not restart the initial scan.  The index uses each field separately, so hidden fields cannot affect your results.  Record access is checked again when searching and opening results.  Initial results may be incomplete while indexing finishes.

Embeddings also improve memory recall.  Without an embedding provider, or during a service outage, recall uses matching words and recent notes.  Search indexes stay in PostgreSQL as float arrays, with cosine search using the vector extension when installed.  Calls appear in the footprint report.  Set {{ui:knowledge.embeddingPower}} to measured or documented power allocated to one embedding request, including hosting overhead.  Energy is that power multiplied by the call duration.  Carbon uses the electricity zone selected in AI settings.  These operational estimates exclude hardware manufacturing and network energy, and depend on the accuracy of the configured power.  Leave power blank when unknown to keep calls explicitly unestimated.
