---
id: web-search
title: Search the web
summary: Find public information and follow the sources behind an answer.
area: rio
order: 11
level: simple
anchors: [knowledge.webSearch, knowledge.sources]
related: [asking-rio, memory]
---

Ask a conversation to search the web.  Answers include {{ui:knowledge.sources}} with links you can open.  Search snippets and fetched pages are treated as untrusted information.  A page cannot change permissions or instruct the application to reveal private data.

An administrator configures {{ui:knowledge.searchAddress}} under {{ui:knowledge.settings}}.  Self-hosted search is available by default once its address is configured.  Turn off {{ui:knowledge.searchEnabled}} to stop searches.

For Compose, enable the `search` profile, set `SEARXNG_SECRET` to a generated secret, and set `RIOSOMA_SEARCH_URL` to the service's root address.  With Helm, turn on `search.enabled` and name an existing Secret using `search.existingSecret`, with a `secret-key` entry.  The chart connects the application to that service automatically.

For a paid service, choose its API format in {{ui:knowledge.searchEngine}}, enter its full search endpoint, and save its credential with {{ui:settings.draft.save}} in the save bar at the bottom of the page.  Subscription token requests send the query as a URL parameter.  Bearer requests send a JSON query.  Credentials are stored encrypted and are never included in conversation results.  A stored credential belongs to the service and endpoint it was entered for.  Changing either one removes it, so enter the credential again in the same save.

Web searches send the query to the configured service.  Page reads are limited in size and duration, and private network destinations and redirects are blocked.  Calls appear in the footprint report.  To estimate energy and carbon, an administrator can set {{ui:knowledge.searchPower}} to measured or documented power allocated to one request, including hosting overhead.  Energy is that power multiplied by the search call duration.  Carbon uses the electricity zone selected in AI settings.  Page reads and upstream search engines are outside this estimate.  Leave power blank when unknown, and the report counts those calls as unestimated.
