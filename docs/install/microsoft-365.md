# Microsoft 365

Riosoma works with Microsoft 365 in five places: it sends email through Microsoft Graph, posts to Teams channels from automations, syncs tables from SharePoint lists, Excel workbooks, and Dataverse, and reads Fabric warehouses as SQL Server sources.  All but Teams sign in as one app registration in Microsoft Entra, which reaches only what an administrator grants it.  This page sets that app up with the least each part needs.  The in-app help, under Syncing from Microsoft 365, covers what people do once it's set up.

## Registering the app

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **Identity**, then **Applications**, then **App registrations**, and choose **New registration**.
2. Name it, such as `Riosoma`, choose **Accounts in this organizational directory only**, leave the redirect URI empty, and choose **Register**.
3. On the overview, note the **Directory (tenant) ID** and the **Application (client) ID**.
4. Under **Certificates & secrets**, choose **New client secret**, pick how long it lasts, and copy its **Value** (not its ID) into your secret store.  It's shown only once.  Put a reminder in your calendar before it expires, since every Microsoft 365 source and the email transport stop signing in when it does.

One app can serve everything below.  Separate apps for email and for data sources keep a leaked secret from reaching both, at the cost of two secrets to rotate.

## Permissions for each part

Each part asks for Microsoft Graph **application** permissions, never delegated ones, since Riosoma signs in as the app itself.

| Part | Microsoft Graph permission | What else it needs |
|---|---|---|
| Email | `Mail.Send` | Scoping to the sending mailbox, in [Email](email.md#microsoft-graph) |
| SharePoint lists | `Sites.Selected` | Read access to each site, [below](#giving-the-app-a-site) |
| Excel workbooks | `Sites.Selected` | Read access to each workbook's site or OneDrive, [below](#giving-the-app-a-site) |
| Dataverse tables | None | An application user in the environment, [below](#adding-the-app-to-a-dataverse-environment) |
| Fabric warehouses | None | A workspace role and a tenant setting, [below](#fabric-warehouses) |
| Teams posts | None | A Workflows webhook, [below](#teams) |

`Sites.Selected` grants nothing on its own: the app reaches only the sites an administrator names.  `Sites.Read.All` instead reads every site in the tenant, which is simpler and much broader.  Graph's Excel workbook API doesn't accept an app's sign-in, so Riosoma downloads a workbook's file and reads it itself, which `Sites.Selected` allows.

To add a permission, open the app registration's **API permissions**, choose **Add a permission**, then **Microsoft Graph**, then **Application permissions**, check it, and choose **Add permissions**.  Then choose **Grant admin consent** for your tenant, which needs a Global Administrator or a Privileged Role Administrator.  Adding a permission requests it and grants nothing until consent.  The same with the Azure CLI, signed in to the tenant:

```bash
APP=<application (client) ID>
GRAPH=00000003-0000-0000-c000-000000000000
for name in Mail.Send Sites.Selected; do
  role=$(az ad sp show --id "$GRAPH" --query "appRoles[?value=='$name'].id | [0]" -o tsv)
  az ad app permission add --id "$APP" --api "$GRAPH" --api-permissions "$role=Role"
done
```

Consent can also be granted by opening `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<application (client) ID>` as an administrator.

## Giving the app a site

With `Sites.Selected`, each SharePoint site and each OneDrive the app may read has to be granted by name.  A SharePoint administrator does it once per site, for example in [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer):

1. Sign in to Graph Explorer as an administrator, and under **Modify permissions**, consent to `Sites.FullControl.All` for Graph Explorer.  That consent is for Graph Explorer, not for Riosoma's app.
2. Find the site's ID, from its address: `GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Garden?$select=id`.  For a OneDrive, the path is `/personal/<user>`, like `/personal/ada_contoso_com`.
3. Grant the app read access:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/<site ID>/permissions

   {
     "roles": ["read"],
     "grantedToIdentities": [
       { "application": { "id": "<application (client) ID>", "displayName": "Riosoma" } }
     ]
   }
   ```

`GET https://graph.microsoft.com/v1.0/sites/<site ID>/permissions` lists what a site has granted, and `DELETE` on one of them takes it back.  Sources only ever read, so `read` is enough.

## Adding the app to a Dataverse environment

Dataverse doesn't use Graph permissions.  Instead, the app becomes one of the environment's users:

1. In the [Power Platform admin center](https://admin.powerplatform.microsoft.com), open **Manage**, then **Environments**, and pick the environment.  Its **Environment URL** is the address a Dataverse source asks for.
2. Choose **Settings**, then **Users + permissions**, then **Application users**, and **New app user**.
3. Choose **Add an app**, pick the app registration, choose the environment's root business unit, and under **Security roles**, add **Basic User**.  Choose **Create**.
4. For tables whose rows other people own, make a security role with **Read** at the **Organization** level on each table people will sync, and add it to the app user too.  Dataverse shows the app only the rows its roles allow.

A source never writes, so it needs no other privilege.

## Fabric warehouses

A Fabric warehouse, a lakehouse's SQL analytics endpoint, and Azure Synapse SQL connect as SQL Server sources, signed in as the app with **Microsoft Entra ID** and **Service principal**.

1. In the [Fabric admin portal](https://app.fabric.microsoft.com/admin-portal/tenantSettings), under **Developer settings**, turn on **Service principals can use Fabric APIs** (**Service principals can call Fabric public APIs** in newer tenants), for the whole organization or for a security group holding the app.
2. In the warehouse's workspace, choose **Manage access**, add the app, and give it the **Viewer** role, which may read the workspace's warehouses.  Sharing just the warehouse with **Read all data using SQL** works too.
3. Copy the warehouse's SQL connection string from its settings, like `abc123.datawarehouse.fabric.microsoft.com`, for the source's host.

The server has to reach port 1433 on `*.datawarehouse.fabric.microsoft.com`.

## Teams

Automations post to Teams through a Workflows webhook, which needs no app registration, and which only a person in the channel can make:

1. In Teams, open the channel's **More options**, then **Workflows**.
2. Choose the template that posts to a channel when a webhook request is received, **Send webhook alerts to a channel** in most tenants, name it, and choose **Next**.
3. Pick the team and channel, choose **Add workflow**, and copy the address it shows.

Riosoma accepts webhook addresses on `*.environment.api.powerplatform.com`, where workflows made since late 2025 answer, and on `*.logic.azure.com` and `*.webhook.office.com`, for older ones.  The server has to reach them over HTTPS.  The address works for anyone who has it, so it's sealed when the automation is saved.

## Microsoft Forms

Microsoft doesn't offer an API for a form's responses.  Forms keeps a form's responses in an Excel workbook, for forms made in a group or a team, or opened with **Open results in Excel**, and an Excel workbook source syncs that.

## What the server reaches

- `login.microsoftonline.com`, for every sign-in
- `graph.microsoft.com`, for email, SharePoint lists, and Excel workbooks
- `*.sharepoint.com`, where Graph sends a workbook's download
- `*.crm.dynamics.com` and its regional forms, like `*.crm4.dynamics.com`, for Dataverse
- `*.datawarehouse.fabric.microsoft.com` on port 1433, for Fabric
- the Workflows webhook hosts above, for Teams

SharePoint, Excel, Dataverse, and Teams go through the server's guarded network, like other sources and webhooks, so a name that resolves to a private address is refused unless the operator allows private hosts.
