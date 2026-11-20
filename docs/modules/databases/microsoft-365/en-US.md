---
id: microsoft-365
title: Syncing from Microsoft 365
summary: Sync SharePoint lists, Excel workbooks in SharePoint or OneDrive, Dataverse tables, Microsoft Forms responses, and Fabric warehouses, and see how each one comes across.
area: databases
order: 16
level: standard
related: [synced-tables, automations, fields]
---

Riosoma syncs tables from four parts of Microsoft 365: SharePoint lists, Excel workbooks kept in SharePoint or OneDrive, Dataverse tables, which hold the data behind Power Apps, and Fabric warehouses.  Their tables sync like any other source's, so everything in {{doc:synced-tables}} applies to them too.  Riosoma only ever reads them, and your overrides stay in Riosoma.

## Before you start

SharePoint, Excel, and Dataverse sources sign in as an app your Microsoft 365 administrator registers in Microsoft Entra, never as a person.  The app reaches only what the administrator grants it, like the sites it may read, so a source can never see more than it was given.  The administrator needs three things from the app registration's overview and its Certificates and secrets page: the directory (tenant) ID, the application (client) ID, and a client secret's value.  Riosoma's install guide for Microsoft 365 walks through the whole setup, permissions and all.

Data Sources admins then choose {{ui:sources.add}} in {{ui:shell.nav.settings}}, pick the kind, and fill in {{ui:sources.field.tenantId}}, {{ui:sources.field.clientId}}, and {{ui:sources.secret.clientSecret}}.  One app can serve every Microsoft 365 source.  Riosoma stores the secret like any other and only ever sends it to Microsoft Entra.

Before you save, choose {{ui:sources.test}}.  It stops at the first step that fails and says what usually fixes it.  A test that fails at {{ui:sources.step.authenticate}} means Microsoft Entra refused the tenant, the client ID, or the secret, and the message says which.  Client secrets expire, after two years at most, so a source that worked for a long time and then stops signing in usually needs a new secret.

## Syncing from SharePoint lists

Choose {{ui:sources.kind.sharePointList}}, and under {{ui:sources.sharepoint.sites}}, paste the address of each site whose lists people may sync, one per line.  The address of any page or list in a site works too, and Riosoma keeps the site's own address.  The app needs read access to each site.

In the sync wizard, each site's lists take the place of tables, under the site's name.  Document libraries and hidden lists aren't offered.  Riosoma keeps track of a list by its ID, so renaming it doesn't stop its synced table.

Columns come across by their own types:

- Single lines of text and multiple lines of text keep their text, and rich text arrives as formatted text.
- Numbers and currency become numbers, with the decimal places the column shows.
- Yes or no becomes a checkbox.
- Dates keep their day, and dates with a time keep the time.
- Choices become single select options, or multiple select options for a column that allows several, with the column's choices already in place.
- Hyperlinks become web addresses.
- People, lookups, and managed metadata hold the names they show, as text.
- Calculated columns hold the values SharePoint works out, typed by their result.
- Locations, images, and SharePoint's own bookkeeping stay out.

The wizard says under each column how it comes across.  Every list also offers `Item ID`, SharePoint's own number for each item, which never changes.  It's the key, and it isn't a field unless you include it.  `Created`, `Modified`, `Created By`, and `Modified By` come along too, for anyone who wants them.

When a column the table reads is renamed or removed in SharePoint, the next sync stops and says which one, rather than emptying the field.

Riosoma doesn't write back to SharePoint.  To change an item, change it in SharePoint, and the next sync brings the change in.  An override changes what everyone sees in Riosoma, and SharePoint keeps its own value.

## Syncing from Excel workbooks

Choose {{ui:sources.kind.excelOnline}}, and under {{ui:sources.excel.workbooks}}, paste each workbook's address, one per line.  To get it, open the workbook in Excel, choose File, then Info, then Copy path.  A sharing link, the kind Share or Copy link gives, isn't the file's own address, so Riosoma asks for the path instead.  A workbook in someone's OneDrive works the same way as one in a SharePoint site, as long as the app may read that OneDrive.

In the sync wizard, each workbook's sheets take the place of tables, under the workbook's name.  Riosoma reads a workbook the way it reads an uploaded one:

- The first row names the columns, a column without a name is named for its place, and a repeated name gets a number.
- Columns get the types an uploaded workbook's columns get: numbers, checkboxes, dates, email addresses, and web addresses.
- Riosoma suggests key columns whose values are all present and all different, like an ID column.

Riosoma keeps track of a workbook by its ID, so after moving or renaming the file, paste its new address into the source, and its synced tables carry on.  A sheet is known by its name, so renaming a sheet stops its synced tables.  Workbooks can be up to 50 MB, and must be saved as .xlsx without a password.

## Syncing from Dataverse

Choose {{ui:sources.kind.dataverse}}, and under {{ui:sources.dataverse.environmentUrl}}, paste the environment's URL, like `https://contoso.crm.dynamics.com`.  It's on the environment's page in the Power Platform admin center.  The app has to be one of the environment's application users, with a security role that may read the tables people sync.

In the sync wizard, the environment's tables are listed by their display names, from Account and Contact to the tables your makers added.  Riosoma keeps track of a table by its logical name, so renaming it doesn't stop its synced table.

Columns come across by their own types:

- Text, email, web address, and phone columns keep their type, and multiline text becomes long text.
- Whole numbers, decimals, floating point numbers, and currency become numbers.
- Yes or no becomes a checkbox, and dates keep their day, or their time for a date and time column.
- Choices, and a row's status, become single select options, and a multiple choice column becomes multiple select options, with the column's choices in place.
- Lookups, customers, and owners hold the name of the row they point at, as text.
- Images, files, and Dataverse's own bookkeeping stay out.

Every table also offers `Row ID`, Dataverse's own ID for each row, which never changes.  It's the key.  Dataverse shows the app only the rows its security role allows, so a role that reads only its own rows makes a synced table that looks almost empty.

## Microsoft Forms responses

Microsoft doesn't offer an API for reading a form's responses, so Riosoma can't sync a form directly.  The supported way is the workbook Forms keeps its responses in:

1. Make the form in a group or a team, or with the Open in Excel choice from a form in your OneDrive, so Forms keeps its responses in an Excel workbook that updates as people respond.
2. In Forms, open Responses, then choose Open results in Excel, and in Excel choose File, then Info, then Copy path.
3. Add that workbook to an {{ui:sources.kind.excelOnline}} source, and sync its sheet with the responses.

Each response has an ID column, which makes a good key.

## Fabric warehouses and Azure Synapse

A Fabric warehouse, a lakehouse's SQL analytics endpoint, and Azure Synapse SQL all speak the same language as SQL Server, so they connect as {{ui:sources.kind.sqlserver}} sources:

1. In Fabric, open the warehouse's settings and copy its SQL connection string, which looks like `abc123.datawarehouse.fabric.microsoft.com`.
2. Choose {{ui:sources.kind.sqlserver}}, paste the connection string into {{ui:sources.field.host}}, and put the warehouse's name in {{ui:sources.field.database}}.
3. Under {{ui:sources.advanced}}, set {{ui:sources.field.auth}} to {{ui:sources.auth.azureEntra}} and {{ui:sources.field.credential}} to {{ui:sources.credential.servicePrincipal}}, then fill in the app's {{ui:sources.field.clientId}}, {{ui:sources.field.tenantId}}, and {{ui:sources.secret.clientSecret}}.

The app needs to be a member of the warehouse's workspace, and Fabric has to let service principals in, which a Fabric administrator turns on once.  Fabric warehouses declare keys without enforcing them, so check the key the wizard suggests.  These sources sync as copies.
