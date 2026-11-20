These responses are authored fixtures based on Notion's public API shapes, pinned to 2026-03-11.  They contain synthetic data, not a capture of a personal workspace.

The recording covers every documented property type, database search and data sources, property-item and block pagination, empty values, unavailable relations, archived and trashed pages, views, attachments, and authentication errors.

The [place property](https://developers.notion.com/reference/page-property-values#place) fixtures include coordinates, a name, an address, provider IDs, and an empty value.

Sources: [data source properties](https://developers.notion.com/reference/property-object), [complete property reads](https://developers.notion.com/guides/data-apis/read-page-property-values), [views](https://developers.notion.com/reference/view), and [versioning](https://developers.notion.com/reference/versioning).

The read-only live suite runs when `RIOSOMA_TEST_NOTION_TOKEN` is set.  Share exactly one database named `Riosoma tests` with the connection.  Related data sources outside that database are refused by the test client.
