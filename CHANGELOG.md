# Changelog

## [0.95.0] - 2026-11-27

Riosoma 0.95.0 is the first public release, and it's a feature-complete preview before 1.0.  It includes everything from 0.95.0-rc.1 (listed below), plus the fixes from running the release candidate against live services and going through each install guide.  This release is English only.  Translation catalogs exist, but the translations aren't finished yet.

- Run the web app and API in one container on AMD64 or ARM64.
- You can install it using Docker Compose, the Helm chart, or the install guides for AWS, Azure, and Google Cloud, with a connector service that runs the driver-based sources.
- Pick a theme, and the app falls back to system fonts when the optional assets aren't there.
- You get signed update notices, and you can use the optional Compose updater to back up and update an install.
- Update straight from 0.95.0-rc.1, since it doesn't need any database changes.

### Connector certification

- The source connectors are certified against live services and a local test fleet, and each one has a dated certificate in [packages/connectors/certifications](packages/connectors/certifications/) showing the checks it passed.

### Data Source

- SFTP reads won't crash the server anymore if a connection closes while a read is still open.  FTP data connections also close before their control connection.
- Sorted results actually stay in order on Trino, Druid, ClickHouse, InfluxDB 3, and Redshift when a query sorts inside a subquery.
- You get a clear error message now instead of an HTTP error when a sort asks for a column that Elasticsearch or Typesense can't sort on (like `_id`, `_index`, or a Typesense field that isn't marked as sortable).
- Firebird sign-in timeouts report as timeouts.
- Athena sources using the default `AwsDataCatalog` work, whereas before they failed on every account.
- DynamoDB row keys now match each row's actual key values and keep very large numbers exact.  This changes the row keys for any DynamoDB syncs made with 0.95.0-rc.1.
- Cosmos DB was refusing sorted reads across partitions, so those now run on each partition key range and get merged together.  Filters and sorts on Cosmos DB system properties are also refused now.
- You can now preview and sync Fabric warehouses and read from them live.  Before, Riosoma connected to the warehouses and listed their tables, but every read failed.  Fabric refuses to run the query Riosoma used to get information about a table's columns.
- NoSQL connector errors now include the HTTP status and the service's error code, but never the response body.
- If Salesforce and Zoho CRM requests stall during setup, they'll retry within the operation's deadline instead of just failing the whole preview or read.

### File ingest

- The file reader was counting touched memory twice, so some workbooks were rejected with a memory limit error.  That's fixed, and each file reader gets 128 MB now.

### Notifications

- Go to Settings, Notifications, and use the Sign in with Microsoft button to connect Teams direct messages instead of pasting a refresh token.  An Integrations administrator sets up the Microsoft app once, either in Settings, Integrations, or using the new `RIOSOMA_MICROSOFT_TEAMS_*` settings.  Then they sign in with the account the messages should come from.  The page shows the sender's account.

### Interface

- Sortable lists will cancel a touch drag if you release it outside the panel, even if the preview hasn't caught up yet.
- The web clipper uses a version format every browser accepts, so release candidates load in Chrome.

### Install guides

- For Azure Container Apps, the guide creates and links a private DNS zone before setting up the database.  It also uses point-in-time restore for rollbacks because burstable servers refuse on-demand backups.
- For Google Cloud Run, the guide now puts startup and liveness probes on `/readyz` and `/healthz` (which Cloud Run's front end reserves), and it adds `--port=8080` to the upgrade deploy command.
- For AWS ECS on Fargate, the guide now creates the ECS service-linked role before the cluster on new accounts, and it uses a dated snapshot name for upgrades.

### Development

- Browser, connector contract, and CI runs are all steadier now across Chromium, Firefox, and WebKit.

## [0.95.0-rc.1] - 2026-11-20

This release candidate for 0.95.0 checks the install guides on each cloud before the release.  The first public build of Riosoma is a feature-complete preview before 1.0.  This release is English only.  Translation catalogs exist, but translations are incomplete.

- Run the web app and API from one container on AMD64 or ARM64.
- Install with Docker Compose, the Helm chart, or the AWS, Azure, and Google Cloud install guides, with a connector service that runs the driver-based sources.
- Choose a theme, with system fonts available when optional assets are absent.
- Receive signed update notices, and use the optional Compose updater to back up and update an install.

### Tables and views

- Spreadsheet-like tables on PostgreSQL with typed fields, attachments, linked records, lookups, rollups, formulas, and reusable named functions
- Grid, list, Kanban, gallery, calendar, timeline, Gantt, map, chart, pivot, and organization chart views
- Filtering, sorting, grouping, conditional colors, validation, and record locks, with sort directions labeled by value type and a field picker that opens first
- Imports, record downloads, comments, change history, undo and redo with confirmation for database and table creation, database copies, and snapshots that start immediately with progress and retry controls
- Find links suggestions for two-letter code fields such as countries and states
- A home screen with named folder rows, fast scrolling through long lists, labeled ways to start a new database or import a CSV or Excel file, and standard dragging across lists and designers

### Data Source

- Connections to SQL databases, warehouses, document databases, spreadsheets, files, APIs, and feeds, with a driver catalog for sources that need separately installed drivers
- App sources chosen by name in the source picker, with guided setup, a link to where each key is made, connection tests, object selection, and clear naming of any missing permission: HubSpot, Pipedrive, Jira, Confluence, Jotform, Calendly, Linear, Trello, Intercom, Shopify, Salesforce, Zoom, Zoho CRM, GitLab, Okta, Freshdesk, Mailchimp, Coda, Typeform, Xero, QuickBooks Online, and GitHub
- Sign-in for app sources through keys, OAuth, or a person's connected account, with tokens renewed for each run and never stored on the source
- Synced tables and live reads for supported connectors, Currency and Percent types for numeric warehouse columns, and clearer connection checks, sync explanations, and field selection guidance
- Inner, left, and full joined tables, local overrides, source-value history, and sync history
- Suggested column combinations in joined tables with editable names, source precedence, and split or widened outputs through REST and MCP
- Sync out to an Airtable table, with a schedule, live progress, run history, Sync now, field-to-column previews, change-only updates, sealed tokens, and an organization policy switch
- Source and joined data that follow table, field, and record access rules
- Connection forms inside the Add a table menu for people who manage sources, masked multi-line secrets that are never shown again after saving, and Snowflake key-pair sign-in help

### File ingest

- Automatic ingestion of incoming files into tables, with ordered processing, visible holds, resumable writes, private notifications, and files held while their formats are failing
- Reading of modern and legacy Excel workbooks, PDF page text, email and Outlook messages, images, and archives, with cell positions preserved, blank cells kept distinct from zero, identifiers kept as text, and explicit reports of reader limits, passwords, and unsupported formats
- Setup that studies unfamiliar files before ingestion, learns formats on probation, and activates only after a person approves, with readiness checks and audited commands
- Reading rules built from examples with blind tests, bounded spending, declarative layouts, signature matching, and questions for unresolved values
- Typed questions with scoped rules and audited answers, review flags, drafts with corrections and spot checks, hand edits preserved across retries, and reversible row removal
- Live upload, activity, question, rule, format, and summary screens with table access checks and realtime updates
- Controlled downloads, retention settings, and configurable probation for original files, with audited cleanup
- Shared file checks for uploads and imports, with scripts and Office macros from outside held, bounded PDF inspection, older TAR archive inspection, and audited outside-file policies

### Workflows and interfaces

- Forms, dashboards, and interfaces with pages and configurable blocks
- Pivot dashboard tiles with row and column groups, summaries, totals, and record drill-down, shareable dashboard filters and date ranges, and chart or pivot views carried into new tiles
- Automations with record, schedule, webhook, and button triggers, draft testing, publishing, and run history
- Manual automation wiring with rewiring, removal, undo, shared drafts, branches and merges, upstream record and token choices, complete simulation playback, and connections exposed through the API and automation tools
- A Send a notification step with recipient choices, inserted values, optional links, delivery that follows each person's preferences, and rendered messages in tests, simulations, and run history
- Automation script steps on their own threads, with per-script time limits, a five-minute budget per run, concurrency caps, and queued published runs
- Scheduled reports with PDF and Office document output
- Published sites with responsive navigation, hero headings, formatted text, images, video, card grids, SVG charts, folding lists, footers, and draft previews
- Site design options including themed bands, record accordions, alternating record sections, muted looping videos, image enlargement, a header button, custom navigation labels, hidden pages, Markdown footer links, and 1 to 100 records per page in each records block
- Gentle reveal, enlargement, and page-fade motion on published sites that owners can turn off, with visitors' reduced-motion preferences taking priority
- Verified custom domains for published sites and forms, HTTPS security headers, and public forms with currency and line items, conditional questions, confirmations, and preserved invalid drafts
- REST API, JavaScript SDK, command-line access, OAuth applications, webhooks, MCP tools with per-token rate limits and admin controls, and Riosoma apps for Zapier and Make

### Rio and AI fields

- Rio conversations that can read permitted data and propose databases, tables, views, dashboards, interfaces, and automation drafts
- Whole-table totals, averages, and rankings under the same record rules, hidden fields, and classification as every other read
- Change previews, approvals, receipts linked to each created table, view, dashboard, and interface, and undo for supported changes
- Automatic dashboard tile layout and plain-language explanations when a plan does not fit
- Configurable providers, AI fields, knowledge libraries, memories, and routines
- Permission checks, data-classification restrictions, usage tracking with this month's AI spending shown in Rio's panel, ingest spending settings, and environmental impact estimates where available
- An AI button in the top bar, conversations and drafts preserved through navigation and reload, and usable phone layouts

### Sharing and administration

- Database roles, field and record permissions, public view links, and organization units
- Sharing of databases and folders with new people under organization policies, invitations with clear restrictions, copied invitation links limited to items the sharer manages, and stronger access preserved when invitations are accepted
- Public view links and webhooks that read with the sharer's access across linked databases, protection of other people's links and embed settings, and password attempt limits counted per network address
- Password and passkey sign-in, two-step sign-in, emailed links, password recovery, administrator reset links, session controls, OIDC and SAML single sign-on, and SCIM provisioning
- Personal profile editing, People controls for roles, account status, and ownership, and a personal menu for settings, appearance, shortcuts, help, and sign out on every screen
- Contextual help for screens and controls, with a movable, resizable documentation window with search, history, and deep links
- Public demo mode with automatic read-only sessions, blocked changes and external requests, shared databases shown to visitors, and calm feedback on edit attempts
- Audit history with improved filters and deep links, retention controls, credential storage bound to the addresses keys were saved for, and configurable attachment storage and virus scanning
- Server setup, install guides, backups, upgrades, configurable update checks, and usage counts that begin disabled
- Riosoma branding throughout the app, organization logos, and theme changes that apply immediately and can be undone

### Security hardening

- Trusted Types enforced in the content security policy, HTTPS security headers on published pages, and a written security walkthrough
- Outside-tool PostgreSQL logins off unless `RIOSOMA_SQL_OUTSIDE_LOGINS=on`, with documented visibility, restricted capabilities, capped temporary files, and connections ended whenever a login is turned off, rotated, tightened, or loses its person or database
- Automations, single-step tests, and webhooks that act only with the access of the person responsible for them, re-checked on reruns, button runs, and resumed runs
- Provider, gateway, and paid search keys sent only to the addresses they were saved for, MongoDB connection strings refused when their options reach past the named servers, and unspecified IPv6 addresses treated as private for outbound requests
- Owner-only password reset links for administrators, owner-only single sign-on provider changes, and read-only provider settings for security admins
- Attachment rules that limit uploads to files a person could already open, hold unscanned pictures out of Word and PowerPoint exports, and preview attachments only as the type their signature names
- Fixed lifetimes for invitations and other expiring links across daylight-saving changes, and refusal of copied invitation links as a way into existing accounts

### Repository and release information

- [Getting started and feature overview](README.md)
- [Nice People License 1.0](LICENSE), with the [EcoLogits port](packages/ecologits/LICENSE) remaining under MPL-2.0
- [Contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), and generated [third-party notices](THIRD_PARTY_NOTICES.md)

The [install guides](docs/install/README.md) cover deployment.  The [help topics](docs/modules/) explain individual features and their configuration requirements.
