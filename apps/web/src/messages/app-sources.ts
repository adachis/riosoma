import { msg } from '@lingui/core/macro';

export const APP_SOURCE_MESSAGES = {
  'sources.app.xero.organization': msg({ id: 'sources.app.xero.organization', message: 'Organization' }),
  'sources.app.xero.organizationHelp': msg({
    id: 'sources.app.xero.organizationHelp',
    message:
      'Choose an organization shared by your connected Xero account.  A single organization is selected automatically.',
  }),
  'sources.app.quickbooks.environment': msg({
    id: 'sources.app.quickbooks.environment',
    message: 'Environment',
  }),
  'sources.app.quickbooks.environmentHelp': msg({
    id: 'sources.app.quickbooks.environmentHelp',
    message: 'Production is the default.  Choose Sandbox when connecting with development credentials.',
  }),
  'sources.app.quickbooks.production': msg({
    id: 'sources.app.quickbooks.production',
    message: 'Production',
  }),
  'sources.app.quickbooks.sandbox': msg({ id: 'sources.app.quickbooks.sandbox', message: 'Sandbox' }),
  'sources.app.objectFault': msg({
    id: 'sources.app.objectFault',
    message: '{object} was left out because the app refused access ({code}).  {reason}',
  }),
  'sources.app.xero.Contacts': msg({ id: 'sources.app.xero.Contacts', message: 'Contacts' }),
  'sources.app.xero.Invoices': msg({ id: 'sources.app.xero.Invoices', message: 'Invoices' }),
  'sources.app.xero.CreditNotes': msg({ id: 'sources.app.xero.CreditNotes', message: 'Credit notes' }),
  'sources.app.xero.Payments': msg({ id: 'sources.app.xero.Payments', message: 'Payments' }),
  'sources.app.xero.BankTransactions': msg({
    id: 'sources.app.xero.BankTransactions',
    message: 'Bank transactions',
  }),
  'sources.app.xero.Accounts': msg({ id: 'sources.app.xero.Accounts', message: 'Accounts' }),
  'sources.app.xero.Items': msg({ id: 'sources.app.xero.Items', message: 'Items' }),
  'sources.app.xero.TaxRates': msg({ id: 'sources.app.xero.TaxRates', message: 'Tax rates' }),
  'sources.app.xero.TrackingCategories': msg({
    id: 'sources.app.xero.TrackingCategories',
    message: 'Tracking categories',
  }),
  'sources.app.xero.Quotes': msg({ id: 'sources.app.xero.Quotes', message: 'Quotes' }),
  'sources.app.xero.PurchaseOrders': msg({
    id: 'sources.app.xero.PurchaseOrders',
    message: 'Purchase orders',
  }),
  'sources.app.xero.ManualJournals': msg({
    id: 'sources.app.xero.ManualJournals',
    message: 'Manual journals',
  }),
  'sources.app.quickbooks.Customer': msg({ id: 'sources.app.quickbooks.Customer', message: 'Customers' }),
  'sources.app.quickbooks.Vendor': msg({ id: 'sources.app.quickbooks.Vendor', message: 'Vendors' }),
  'sources.app.quickbooks.Employee': msg({ id: 'sources.app.quickbooks.Employee', message: 'Employees' }),
  'sources.app.quickbooks.Item': msg({ id: 'sources.app.quickbooks.Item', message: 'Items' }),
  'sources.app.quickbooks.Account': msg({ id: 'sources.app.quickbooks.Account', message: 'Accounts' }),
  'sources.app.quickbooks.Invoice': msg({ id: 'sources.app.quickbooks.Invoice', message: 'Invoices' }),
  'sources.app.quickbooks.Bill': msg({ id: 'sources.app.quickbooks.Bill', message: 'Bills' }),
  'sources.app.quickbooks.Payment': msg({ id: 'sources.app.quickbooks.Payment', message: 'Payments' }),
  'sources.app.quickbooks.BillPayment': msg({
    id: 'sources.app.quickbooks.BillPayment',
    message: 'Bill payments',
  }),
  'sources.app.quickbooks.Estimate': msg({ id: 'sources.app.quickbooks.Estimate', message: 'Estimates' }),
  'sources.app.quickbooks.SalesReceipt': msg({
    id: 'sources.app.quickbooks.SalesReceipt',
    message: 'Sales receipts',
  }),
  'sources.app.quickbooks.PurchaseOrder': msg({
    id: 'sources.app.quickbooks.PurchaseOrder',
    message: 'Purchase orders',
  }),
  'sources.app.quickbooks.CreditMemo': msg({
    id: 'sources.app.quickbooks.CreditMemo',
    message: 'Credit memos',
  }),
  'sources.app.quickbooks.JournalEntry': msg({
    id: 'sources.app.quickbooks.JournalEntry',
    message: 'Journal entries',
  }),
  'sources.app.quickbooks.Class': msg({ id: 'sources.app.quickbooks.Class', message: 'Classes' }),
  'sources.app.quickbooks.Department': msg({
    id: 'sources.app.quickbooks.Department',
    message: 'Departments',
  }),
  'sources.app.quickbooks.TaxCode': msg({ id: 'sources.app.quickbooks.TaxCode', message: 'Tax codes' }),

  'sources.app.trello.keyLabel': msg({
    id: 'sources.app.trello.keyLabel',
    message: 'API key',
  }),
  'sources.app.trello.keyHelp': msg({
    id: 'sources.app.trello.keyHelp',
    message:
      'Find the public API key on the same page as the token, in your Power-Up’s API key tab at https://trello.com/power-ups/admin.',
  }),
  'sources.app.trello.keyRequired': msg({
    id: 'sources.app.trello.keyRequired',
    message: 'Enter your Trello API key.',
  }),
  'sources.app.trello.keyInvalid': msg({
    id: 'sources.app.trello.keyInvalid',
    message: 'Enter the Trello API key as 32 lowercase hexadecimal characters.',
  }),
  'sources.app.trello.tokenHelp': msg({
    id: 'sources.app.trello.tokenHelp',
    message:
      'Use a Trello token with read access to your boards.  Create it from the API key tab of a Power-Up at https://trello.com/power-ups/admin.  This source syncs open boards.',
  }),
  'sources.app.trello.deniedToken': msg({
    id: 'sources.app.trello.deniedToken',
    message:
      'Trello refused the API key or token.  Check the key and create a new token from your Power-Up’s API key tab at https://trello.com/power-ups/admin.',
  }),
  'sources.app.intercom.regionLabel': msg({
    id: 'sources.app.intercom.regionLabel',
    message: 'Workspace region',
  }),
  'sources.app.intercom.regionHelp': msg({
    id: 'sources.app.intercom.regionHelp',
    message:
      'Choose us for the United States, eu for Europe, or au for Australia.  The United States is the default.',
  }),
  'sources.app.intercom.regionInvalid': msg({
    id: 'sources.app.intercom.regionInvalid',
    message: 'Choose us, eu, or au for your Intercom workspace region.',
  }),
  'sources.app.intercom.tokenHelp': msg({
    id: 'sources.app.intercom.tokenHelp',
    message:
      'Create an Intercom access token with read access in the Developer Hub at https://app.intercom.com/a/apps/_/developer-hub.  The app’s configured API version applies.',
  }),
  'sources.app.intercom.deniedToken': msg({
    id: 'sources.app.intercom.deniedToken',
    message:
      'Intercom refused the access token.  Check your workspace region and create a token with read access at https://app.intercom.com/a/apps/_/developer-hub.',
  }),
  'sources.app.shopify.storeLabel': msg({
    id: 'sources.app.shopify.storeLabel',
    message: 'Store address',
  }),
  'sources.app.shopify.storeHelp': msg({
    id: 'sources.app.shopify.storeHelp',
    message:
      'Enter your store name or its HTTPS address on myshopify.com, such as https://your-store.myshopify.com.',
  }),
  'sources.app.shopify.storeRequired': msg({
    id: 'sources.app.shopify.storeRequired',
    message: 'Enter your Shopify store name or address.',
  }),
  'sources.app.shopify.storeInvalid': msg({
    id: 'sources.app.shopify.storeInvalid',
    message: 'Enter a valid Shopify store name or HTTPS address without spaces.',
  }),
  'sources.app.shopify.storeHttps': msg({
    id: 'sources.app.shopify.storeHttps',
    message: 'Use HTTPS for your Shopify store address.',
  }),
  'sources.app.shopify.storeHost': msg({
    id: 'sources.app.shopify.storeHost',
    message: 'Use your store’s address on a host ending in .myshopify.com.',
  }),
  'sources.app.shopify.storeCredentials': msg({
    id: 'sources.app.shopify.storeCredentials',
    message: 'Remove credentials from the store address.  Enter the Admin API access token in the key field.',
  }),
  'sources.app.shopify.storePort': msg({
    id: 'sources.app.shopify.storePort',
    message: 'Remove the port from your Shopify store address.',
  }),
  'sources.app.shopify.storePath': msg({
    id: 'sources.app.shopify.storePath',
    message: 'Remove the path from your Shopify store address.',
  }),
  'sources.app.shopify.storeQuery': msg({
    id: 'sources.app.shopify.storeQuery',
    message: 'Remove query parameters from your Shopify store address.',
  }),
  'sources.app.shopify.storeFragment': msg({
    id: 'sources.app.shopify.storeFragment',
    message: 'Remove the fragment after # from your Shopify store address.',
  }),
  'sources.app.shopify.tokenHelp': msg({
    id: 'sources.app.shopify.tokenHelp',
    message:
      'Use a Shopify custom app’s Admin API access token.  Grant read_products for products and collections, read_customers for customers, read_orders for orders, and read_draft_orders for draft orders.  Follow https://help.shopify.com/en/manual/apps/app-types/custom-apps.',
  }),
  'sources.app.shopify.deniedToken': msg({
    id: 'sources.app.shopify.deniedToken',
    message:
      'Shopify refused the Admin API access token.  Create a custom app token with the required read scopes using https://help.shopify.com/en/manual/apps/app-types/custom-apps.',
  }),
  'sources.app.salesforce.instanceLabel': msg({
    id: 'sources.app.salesforce.instanceLabel',
    message: 'Instance address',
  }),
  'sources.app.salesforce.instanceHelp': msg({
    id: 'sources.app.salesforce.instanceHelp',
    message:
      'Use your HTTPS address on my.salesforce.com, such as https://your-name-dev-ed.develop.my.salesforce.com.',
  }),
  'sources.app.salesforce.instanceRequired': msg({
    id: 'sources.app.salesforce.instanceRequired',
    message: 'Enter your Salesforce instance address.',
  }),
  'sources.app.salesforce.instanceInvalid': msg({
    id: 'sources.app.salesforce.instanceInvalid',
    message: 'Enter a valid Salesforce instance address without spaces.',
  }),
  'sources.app.salesforce.instanceHttps': msg({
    id: 'sources.app.salesforce.instanceHttps',
    message: 'Use HTTPS for your Salesforce instance address.',
  }),
  'sources.app.salesforce.instanceHost': msg({
    id: 'sources.app.salesforce.instanceHost',
    message: 'Use an instance host ending in .my.salesforce.com.',
  }),
  'sources.app.salesforce.instanceCredentials': msg({
    id: 'sources.app.salesforce.instanceCredentials',
    message: 'Remove credentials from the Salesforce instance address.',
  }),
  'sources.app.salesforce.instancePort': msg({
    id: 'sources.app.salesforce.instancePort',
    message: 'Remove the port from the Salesforce instance address.',
  }),
  'sources.app.salesforce.instancePath': msg({
    id: 'sources.app.salesforce.instancePath',
    message: 'Remove the path from the Salesforce instance address.',
  }),
  'sources.app.salesforce.instanceQuery': msg({
    id: 'sources.app.salesforce.instanceQuery',
    message: 'Remove query parameters from the Salesforce instance address.',
  }),
  'sources.app.salesforce.instanceFragment': msg({
    id: 'sources.app.salesforce.instanceFragment',
    message: 'Remove the fragment after # from the Salesforce instance address.',
  }),
  'sources.app.salesforce.clientIdLabel': msg({
    id: 'sources.app.salesforce.clientIdLabel',
    message: 'Consumer key',
  }),
  'sources.app.salesforce.clientIdHelp': msg({
    id: 'sources.app.salesforce.clientIdHelp',
    message: 'Copy the consumer key from your Salesforce external client app.',
  }),
  'sources.app.salesforce.clientIdRequired': msg({
    id: 'sources.app.salesforce.clientIdRequired',
    message: 'Enter your Salesforce consumer key.',
  }),
  'sources.app.salesforce.clientIdInvalid': msg({
    id: 'sources.app.salesforce.clientIdInvalid',
    message:
      'Enter a Salesforce consumer key using letters, numbers, periods, underscores, or hyphens, up to 512 characters.',
  }),
  'sources.app.salesforce.secretHelp': msg({
    id: 'sources.app.salesforce.secretHelp',
    message:
      'Use the client secret of an external client app with the client credentials flow, a Run As user, and the api scope.',
  }),
  'sources.app.salesforce.deniedKey': msg({
    id: 'sources.app.salesforce.deniedKey',
    message:
      'Salesforce refused the client credentials.  Check the consumer key, client secret, client credentials flow, Run As user, and api scope.  Follow {keyUrl} to set up the app.',
  }),
  'sources.app.zoom.accountIdLabel': msg({
    id: 'sources.app.zoom.accountIdLabel',
    message: 'Account ID',
  }),
  'sources.app.zoom.accountIdHelp': msg({
    id: 'sources.app.zoom.accountIdHelp',
    message: 'Copy the account ID from your Zoom Server-to-Server OAuth app.',
  }),
  'sources.app.zoom.accountIdRequired': msg({
    id: 'sources.app.zoom.accountIdRequired',
    message: 'Enter your Zoom account ID.',
  }),
  'sources.app.zoom.accountIdInvalid': msg({
    id: 'sources.app.zoom.accountIdInvalid',
    message: 'Enter a Zoom account ID using letters, numbers, underscores, or hyphens, up to 256 characters.',
  }),
  'sources.app.zoom.clientIdLabel': msg({
    id: 'sources.app.zoom.clientIdLabel',
    message: 'Client ID',
  }),
  'sources.app.zoom.clientIdHelp': msg({
    id: 'sources.app.zoom.clientIdHelp',
    message: 'Copy the client ID from your Zoom Server-to-Server OAuth app.',
  }),
  'sources.app.zoom.clientIdRequired': msg({
    id: 'sources.app.zoom.clientIdRequired',
    message: 'Enter your Zoom client ID.',
  }),
  'sources.app.zoom.clientIdInvalid': msg({
    id: 'sources.app.zoom.clientIdInvalid',
    message: 'Enter a Zoom client ID using letters, numbers, underscores, or hyphens, up to 256 characters.',
  }),
  'sources.app.zoom.secretHelp': msg({
    id: 'sources.app.zoom.secretHelp',
    message:
      'Use your Zoom client secret.  The key test needs user:read:user:admin, Users needs user:read:list_users:admin, Groups needs group:read:list_groups:admin, and user meetings need meeting:read:list_meetings:admin.',
  }),
  'sources.app.zoom.deniedKey': msg({
    id: 'sources.app.zoom.deniedKey',
    message:
      'Zoom refused the client credentials.  Check the account ID, client ID, client secret, and user:read:user:admin scope.  Create or activate a Server-to-Server OAuth app using {keyUrl}.',
  }),
  'sources.app.zoom.users': msg({
    id: 'sources.app.zoom.users',
    message: 'Users',
  }),
  'sources.app.zoom.groups': msg({
    id: 'sources.app.zoom.groups',
    message: 'Groups',
  }),
  'sources.app.zoom.meetings': msg({
    id: 'sources.app.zoom.meetings',
    message: '{label} meetings',
  }),
  'sources.app.zoho.regionLabel': msg({
    id: 'sources.app.zoho.regionLabel',
    message: 'Data center',
  }),
  'sources.app.zoho.regionHelp': msg({
    id: 'sources.app.zoho.regionHelp',
    message:
      'Choose com for the United States, eu for Europe, in for India, com.au for Australia, jp for Japan, ca for Canada, sa for Saudi Arabia, or uk for the United Kingdom.  The default is com.',
  }),
  'sources.app.zoho.regionInvalid': msg({
    id: 'sources.app.zoho.regionInvalid',
    message: 'Choose one of the supported Zoho CRM data centers.',
  }),
  'sources.app.zoho.clientIdLabel': msg({
    id: 'sources.app.zoho.clientIdLabel',
    message: 'Client ID',
  }),
  'sources.app.zoho.clientIdHelp': msg({
    id: 'sources.app.zoho.clientIdHelp',
    message:
      'Copy the Self Client ID from the Zoho API Console.  It starts with 1000. followed by letters and numbers.',
  }),
  'sources.app.zoho.clientIdRequired': msg({
    id: 'sources.app.zoho.clientIdRequired',
    message: 'Enter your Zoho CRM client ID.',
  }),
  'sources.app.zoho.clientIdInvalid': msg({
    id: 'sources.app.zoho.clientIdInvalid',
    message: 'Enter a Zoho CRM client ID: 1000. followed by letters and numbers.',
  }),
  'sources.app.zoho.secretHelp': msg({
    id: 'sources.app.zoho.secretHelp',
    message:
      'Create a Self Client at https://api-console.zoho.com/ with ZohoCRM.modules.READ, ZohoCRM.settings.READ, ZohoCRM.users.READ, and ZohoCRM.org.READ, and copy its client secret.',
  }),
  'sources.app.zoho.refreshTokenLabel': msg({
    id: 'sources.app.zoho.refreshTokenLabel',
    message: 'Refresh token',
  }),
  'sources.app.zoho.refreshTokenHelp': msg({
    id: 'sources.app.zoho.refreshTokenHelp',
    message:
      'Exchange the Self Client code for a refresh token in your data center using https://www.zoho.com/crm/developer/docs/api/v8/auth-request.html#self-client.',
  }),
  'sources.app.zoho.deniedKey': msg({
    id: 'sources.app.zoho.deniedKey',
    message:
      'Zoho CRM refused the client credentials or refresh token.  Check the data center, client ID, client secret, refresh token, and read scopes.  Create a Self Client at {keyUrl}.',
  }),
  'sources.app.gitlab.tokenHelp': msg({
    id: 'sources.app.gitlab.tokenHelp',
    message:
      'Use a personal, group, or project access token with read_api for GitLab.com.  Self-managed GitLab can use the generic API source.',
  }),
  'sources.app.gitlab.deniedToken': msg({
    id: 'sources.app.gitlab.deniedToken',
    message:
      'GitLab refused the access token.  Create a token with read_api at https://gitlab.com/-/user_settings/personal_access_tokens.',
  }),
  'sources.app.gitlab.projects': msg({
    id: 'sources.app.gitlab.projects',
    message: 'Projects',
  }),
  'sources.app.gitlab.groups': msg({
    id: 'sources.app.gitlab.groups',
    message: 'Groups',
  }),
  'sources.app.gitlab.issues': msg({
    id: 'sources.app.gitlab.issues',
    message: '{parent} issues',
  }),
  'sources.app.gitlab.merge_requests': msg({
    id: 'sources.app.gitlab.merge_requests',
    message: '{parent} merge requests',
  }),
  'sources.app.okta.tokenHelp': msg({
    id: 'sources.app.okta.tokenHelp',
    message:
      'Use an Okta API token created by a read-only admin.  The token has its creator’s admin permissions.',
  }),
  'sources.app.okta.deniedToken': msg({
    id: 'sources.app.okta.deniedToken',
    message:
      'Okta refused the API token.  Create a new token using the instructions at https://help.okta.com/en-us/content/topics/security/api.htm.',
  }),
  'sources.app.okta.objectNotAllowed': msg({
    id: 'sources.app.okta.objectNotAllowed',
    message: 'The token’s admin cannot read {object}.',
  }),
  'sources.app.okta.users': msg({
    id: 'sources.app.okta.users',
    message: 'Users',
  }),
  'sources.app.okta.groups': msg({
    id: 'sources.app.okta.groups',
    message: 'Groups',
  }),
  'sources.app.okta.applications': msg({
    id: 'sources.app.okta.applications',
    message: 'Applications',
  }),
  'sources.app.okta.systemLog': msg({
    id: 'sources.app.okta.systemLog',
    message: 'System log',
  }),
  'sources.app.okta.members': msg({
    id: 'sources.app.okta.members',
    message: '{parent} members',
  }),
  'sources.app.freshdesk.keyHelp': msg({
    id: 'sources.app.freshdesk.keyHelp',
    message: 'Use your Freshdesk API key from Profile Settings, View API key.',
  }),
  'sources.app.freshdesk.deniedKey': msg({
    id: 'sources.app.freshdesk.deniedKey',
    message:
      'Freshdesk refused the API key.  Find your key at https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key.',
  }),
  'sources.app.freshdesk.tickets': msg({
    id: 'sources.app.freshdesk.tickets',
    message: 'Tickets',
  }),
  'sources.app.freshdesk.contacts': msg({
    id: 'sources.app.freshdesk.contacts',
    message: 'Contacts',
  }),
  'sources.app.freshdesk.companies': msg({
    id: 'sources.app.freshdesk.companies',
    message: 'Companies',
  }),
  'sources.app.freshdesk.agents': msg({
    id: 'sources.app.freshdesk.agents',
    message: 'Agents',
  }),
  'sources.app.freshdesk.groups': msg({
    id: 'sources.app.freshdesk.groups',
    message: 'Groups',
  }),
  'sources.app.mailchimp.keyHelp': msg({
    id: 'sources.app.mailchimp.keyHelp',
    message:
      'Use a Mailchimp API key including its data center suffix, such as -us21.  Create one at https://mailchimp.com/help/about-api-keys/.',
  }),
  'sources.app.mailchimp.deniedKey': msg({
    id: 'sources.app.mailchimp.deniedKey',
    message:
      'Mailchimp refused the API key.  Create a new key at https://mailchimp.com/help/about-api-keys/.',
  }),
  'sources.app.mailchimp.audiences': msg({
    id: 'sources.app.mailchimp.audiences',
    message: 'Audiences',
  }),
  'sources.app.mailchimp.members': msg({
    id: 'sources.app.mailchimp.members',
    message: '{parent} members',
  }),
  'sources.app.mailchimp.campaigns': msg({
    id: 'sources.app.mailchimp.campaigns',
    message: 'Campaigns',
  }),
  'sources.app.mailchimp.templates': msg({
    id: 'sources.app.mailchimp.templates',
    message: 'Templates',
  }),
  'sources.app.mailchimp.automations': msg({
    id: 'sources.app.mailchimp.automations',
    message: 'Automations',
  }),
  'sources.app.mailchimp.reports': msg({
    id: 'sources.app.mailchimp.reports',
    message: 'Reports',
  }),
  'sources.app.okta.organizationLabel': msg({
    id: 'sources.app.okta.organizationLabel',
    message: 'Organization address',
  }),
  'sources.app.okta.organizationHelp': msg({
    id: 'sources.app.okta.organizationHelp',
    message:
      'Enter your Okta organization name or its HTTPS address, such as https://your-organization.okta.com.',
  }),
  'sources.app.okta.organizationRequired': msg({
    id: 'sources.app.okta.organizationRequired',
    message: 'Enter your Okta organization address or name.',
  }),
  'sources.app.okta.organizationInvalid': msg({
    id: 'sources.app.okta.organizationInvalid',
    message: 'Enter a valid Okta organization name or HTTPS address without spaces.',
  }),
  'sources.app.okta.organizationHttps': msg({
    id: 'sources.app.okta.organizationHttps',
    message: 'Use HTTPS for your Okta organization address.',
  }),
  'sources.app.okta.organizationHost': msg({
    id: 'sources.app.okta.organizationHost',
    message: 'Use your organization’s address on a host ending in .okta.com.',
  }),
  'sources.app.okta.organizationCredentials': msg({
    id: 'sources.app.okta.organizationCredentials',
    message: 'Remove credentials from the organization address.  Enter the API key in its own field.',
  }),
  'sources.app.okta.organizationPort': msg({
    id: 'sources.app.okta.organizationPort',
    message: 'Remove the port from your Okta organization address.',
  }),
  'sources.app.okta.organizationPath': msg({
    id: 'sources.app.okta.organizationPath',
    message: 'Remove the path from your Okta organization address.',
  }),
  'sources.app.okta.organizationQuery': msg({
    id: 'sources.app.okta.organizationQuery',
    message: 'Remove query parameters from your Okta organization address.',
  }),
  'sources.app.okta.organizationFragment': msg({
    id: 'sources.app.okta.organizationFragment',
    message: 'Remove the fragment after # from your Okta organization address.',
  }),
  'sources.app.freshdesk.helpdeskLabel': msg({
    id: 'sources.app.freshdesk.helpdeskLabel',
    message: 'Helpdesk address',
  }),
  'sources.app.freshdesk.helpdeskHelp': msg({
    id: 'sources.app.freshdesk.helpdeskHelp',
    message:
      'Enter your Freshdesk helpdesk name or its HTTPS address, such as https://your-helpdesk.freshdesk.com.',
  }),
  'sources.app.freshdesk.helpdeskRequired': msg({
    id: 'sources.app.freshdesk.helpdeskRequired',
    message: 'Enter your Freshdesk helpdesk address or name.',
  }),
  'sources.app.freshdesk.helpdeskInvalid': msg({
    id: 'sources.app.freshdesk.helpdeskInvalid',
    message: 'Enter a valid Freshdesk helpdesk name or HTTPS address without spaces.',
  }),
  'sources.app.freshdesk.helpdeskHttps': msg({
    id: 'sources.app.freshdesk.helpdeskHttps',
    message: 'Use HTTPS for your Freshdesk helpdesk address.',
  }),
  'sources.app.freshdesk.helpdeskHost': msg({
    id: 'sources.app.freshdesk.helpdeskHost',
    message: 'Use your helpdesk’s address on a host ending in .freshdesk.com.',
  }),
  'sources.app.freshdesk.helpdeskCredentials': msg({
    id: 'sources.app.freshdesk.helpdeskCredentials',
    message: 'Remove credentials from the helpdesk address.  Enter the API key in its own field.',
  }),
  'sources.app.freshdesk.helpdeskPort': msg({
    id: 'sources.app.freshdesk.helpdeskPort',
    message: 'Remove the port from your Freshdesk helpdesk address.',
  }),
  'sources.app.freshdesk.helpdeskPath': msg({
    id: 'sources.app.freshdesk.helpdeskPath',
    message: 'Remove the path from your Freshdesk helpdesk address.',
  }),
  'sources.app.freshdesk.helpdeskQuery': msg({
    id: 'sources.app.freshdesk.helpdeskQuery',
    message: 'Remove query parameters from your Freshdesk helpdesk address.',
  }),
  'sources.app.freshdesk.helpdeskFragment': msg({
    id: 'sources.app.freshdesk.helpdeskFragment',
    message: 'Remove the fragment after # from your Freshdesk helpdesk address.',
  }),
  'sources.app.connectionRequired': msg({
    id: 'sources.app.connectionRequired',
    message: 'Choose one of your connected accounts for this provider in this organization.',
  }),
  'sources.app.connectionSecrets': msg({
    id: 'sources.app.connectionSecrets',
    message: 'This app uses a connected account.  Choose an account instead of entering a key.',
  }),
  'sources.app.connectionRefused': msg({
    id: 'sources.app.connectionRefused',
    message: 'The service refused this account.  Connect the account again before testing or syncing.',
  }),
  'sources.app.reconnect': msg({
    id: 'sources.app.reconnect',
    message:
      'The account connected by {name} is unavailable.  Ask {name} to connect again under Settings, Connected accounts.',
  }),
  'sources.app.disconnectWarning': msg({
    id: 'sources.app.disconnectWarning',
    message:
      'These sources will stop syncing: {sources}.  Connect again and update each source to resume syncing.',
  }),
  'sources.app.connectedHelp': msg({
    id: 'sources.app.connectedHelp',
    message:
      'Connect your account to share read access with this source.  Scheduled syncs use your connected account.',
  }),
  'sources.app.github.repositories': msg({ id: 'sources.app.github.repositories', message: 'Repositories' }),
  'sources.app.github.issues': msg({ id: 'sources.app.github.issues', message: '{parent} / Issues' }),
  'sources.app.github.pulls': msg({ id: 'sources.app.github.pulls', message: '{parent} / Pull requests' }),
  'sources.app.atlassian.siteLabel': msg({
    id: 'sources.app.atlassian.siteLabel',
    message: 'Site address',
  }),
  'sources.app.atlassian.siteHelp': msg({
    id: 'sources.app.atlassian.siteHelp',
    message: 'Enter your Atlassian site name or its HTTPS address, such as https://your-site.atlassian.net.',
  }),
  'sources.app.atlassian.siteRequired': msg({
    id: 'sources.app.atlassian.siteRequired',
    message: 'Enter your Atlassian site address or site name.',
  }),
  'sources.app.atlassian.siteInvalid': msg({
    id: 'sources.app.atlassian.siteInvalid',
    message: 'Enter a valid Atlassian site name or HTTPS address without spaces.',
  }),
  'sources.app.atlassian.siteHttps': msg({
    id: 'sources.app.atlassian.siteHttps',
    message: 'Use HTTPS for your Atlassian site address.',
  }),
  'sources.app.atlassian.siteHost': msg({
    id: 'sources.app.atlassian.siteHost',
    message: 'Use your site’s address on a host ending in .atlassian.net.',
  }),
  'sources.app.atlassian.siteCredentials': msg({
    id: 'sources.app.atlassian.siteCredentials',
    message:
      'Remove credentials from the site address.  Enter your account email and API token in their own fields.',
  }),
  'sources.app.atlassian.sitePort': msg({
    id: 'sources.app.atlassian.sitePort',
    message: 'Remove the port from your Atlassian site address.',
  }),
  'sources.app.atlassian.sitePath': msg({
    id: 'sources.app.atlassian.sitePath',
    message: 'Remove the path from your Atlassian site address, including /wiki.',
  }),
  'sources.app.atlassian.siteQuery': msg({
    id: 'sources.app.atlassian.siteQuery',
    message: 'Remove query parameters from your Atlassian site address.',
  }),
  'sources.app.atlassian.siteFragment': msg({
    id: 'sources.app.atlassian.siteFragment',
    message: 'Remove the fragment after # from your Atlassian site address.',
  }),
  'sources.app.atlassian.emailLabel': msg({
    id: 'sources.app.atlassian.emailLabel',
    message: 'Account email',
  }),
  'sources.app.atlassian.emailHelp': msg({
    id: 'sources.app.atlassian.emailHelp',
    message: 'Use the email address of the Atlassian account that owns the API token.',
  }),
  'sources.app.atlassian.emailRequired': msg({
    id: 'sources.app.atlassian.emailRequired',
    message: 'Enter your Atlassian account email address.',
  }),
  'sources.app.atlassian.emailInvalid': msg({
    id: 'sources.app.atlassian.emailInvalid',
    message: 'Enter a valid Atlassian account email address.',
  }),
  'sources.app.atlassian.tokenHelp': msg({
    id: 'sources.app.atlassian.tokenHelp',
    message:
      'Use an Atlassian API token for your account.  Create one at https://id.atlassian.com/manage-profile/security/api-tokens.',
  }),
  'sources.app.atlassian.deniedToken': msg({
    id: 'sources.app.atlassian.deniedToken',
    message:
      'Atlassian refused the API token.  Check your account email and create a new token at https://id.atlassian.com/manage-profile/security/api-tokens.',
  }),
  'sources.app.unknown': msg({
    id: 'sources.app.unknown',
    message: 'Choose an app from the source catalog.',
  }),
  'sources.app.undeclaredSetting': msg({
    id: 'sources.app.undeclaredSetting',
    message: 'This app does not accept that setting.',
  }),
  'sources.app.settingRequired': msg({
    id: 'sources.app.settingRequired',
    message: 'Enter the required app setting.',
  }),
  'sources.app.settingInvalid': msg({
    id: 'sources.app.settingInvalid',
    message: 'Check the app setting and its allowed values.',
  }),
  'sources.app.address': msg({
    id: 'sources.app.address',
    message: 'Use an HTTPS address on the app’s own domain, without credentials, a port, or a path.',
  }),
  'sources.app.keyInvalid': msg({
    id: 'sources.app.keyInvalid',
    message: 'This key does not look like this app’s key.  Check the key page and create a new key.',
  }),
  'sources.app.secretMissing': msg({
    id: 'sources.app.secretMissing',
    message:
      '{hasField, select, true {Enter {field} before testing or syncing.} other {Enter the key this app needs before testing or syncing.}}',
  }),
  'sources.app.hubspot.tokenHelp': msg({
    id: 'sources.app.hubspot.tokenHelp',
    message:
      'Use a HubSpot private app token with read access to the objects you want to sync.  Create it in HubSpot under Development, Legacy apps.',
  }),
  'sources.app.hubspot.deniedToken': msg({
    id: 'sources.app.hubspot.deniedToken',
    message:
      'HubSpot refused the private app token.  Create a new token in HubSpot under Development, Legacy apps, and grant read access to the objects you want to sync.',
  }),
  'sources.app.pipedrive.tokenHelp': msg({
    id: 'sources.app.pipedrive.tokenHelp',
    message: 'Use your Pipedrive personal API token from Personal preferences, API.',
  }),
  'sources.app.pipedrive.deniedToken': msg({
    id: 'sources.app.pipedrive.deniedToken',
    message:
      'Pipedrive refused the personal API token.  Get a new token in Pipedrive under Personal preferences, API.',
  }),
  'sources.app.calendly.tokenHelp': msg({
    id: 'sources.app.calendly.tokenHelp',
    message:
      'Use a Calendly personal access token created by an organization admin or owner to sync organization-wide data.  Create it in Calendly under Integrations & apps, API and webhooks, and grant read access to users, scheduled events, event types, and organizations.',
  }),
  'sources.app.calendly.deniedToken': msg({
    id: 'sources.app.calendly.deniedToken',
    message:
      'Calendly refused the personal access token.  Ask your Calendly organization admin or owner to create a token for organization-wide data under Integrations & apps, API and webhooks, and grant read access to users, scheduled events, event types, and organizations.',
  }),
  'sources.app.accountValues': msg({
    id: 'sources.app.accountValues',
    message:
      'The app did not return the account information needed to list its objects.  Check the key’s read permissions and try again.',
  }),
  'sources.app.coda.tokenHelp': msg({
    id: 'sources.app.coda.tokenHelp',
    message:
      'Create an API token in Coda under Account settings, API settings, and allow read access to the docs you want to sync.',
  }),
  'sources.app.coda.deniedToken': msg({
    id: 'sources.app.coda.deniedToken',
    message:
      'Coda refused the API token.  Create a new token at https://coda.io/account under API settings, and allow read access to your docs.',
  }),
  'sources.app.typeform.tokenHelp': msg({
    id: 'sources.app.typeform.tokenHelp',
    message:
      'Create a Typeform personal access token with forms:read, responses:read, and workspaces:read scopes under Account settings, Personal tokens.',
  }),
  'sources.app.typeform.deniedToken': msg({
    id: 'sources.app.typeform.deniedToken',
    message:
      'Typeform refused the personal access token.  Create a new token at https://admin.typeform.com/user/tokens with forms:read, responses:read, and workspaces:read scopes.',
  }),
  'sources.app.typeform.region': msg({
    id: 'sources.app.typeform.region',
    message: 'Account region',
  }),
  'sources.app.typeform.regionHelp': msg({
    id: 'sources.app.typeform.regionHelp',
    message:
      'Choose default for the default Typeform data center, eu for the existing EU data center, or eu-new for the new EU data center.  Ask your Typeform Customer Success Manager if you are unsure which region your account uses.',
  }),
  'sources.app.typeform.regionInvalid': msg({
    id: 'sources.app.typeform.regionInvalid',
    message: 'Choose default, eu, or eu-new for Typeform.',
  }),
  'sources.app.jotform.keyHelp': msg({
    id: 'sources.app.jotform.keyHelp',
    message: 'Create a read-only API key in Jotform under My Account, API.',
  }),
  'sources.app.jotform.deniedKey': msg({
    id: 'sources.app.jotform.deniedKey',
    message: 'Jotform refused the API key.  Create a read-only key in Jotform under My Account, API.',
  }),
  'sources.app.jotform.region': msg({
    id: 'sources.app.jotform.region',
    message: 'Account region',
  }),
  'sources.app.jotform.regionHelp': msg({
    id: 'sources.app.jotform.regionHelp',
    message: 'Choose the default, EU, or HIPAA region for your Jotform account.',
  }),
  'sources.app.https': msg({
    id: 'sources.app.https',
    message: 'The app must use HTTPS.  An operator may allow HTTP to localhost for testing.',
  }),
  'sources.app.linear.keyHelp': msg({
    id: 'sources.app.linear.keyHelp',
    message:
      'Use a Linear personal API key with read access to the objects you want to sync.  Create it in Linear under Settings, Security & access, Personal API keys.',
  }),
  'sources.app.linear.deniedKey': msg({
    id: 'sources.app.linear.deniedKey',
    message:
      'Linear refused the personal API key.  Create a new key in Linear under Settings, Security & access, Personal API keys, and grant read access to the objects you want to sync.',
  }),
  'sources.app.blocked': msg({
    id: 'sources.app.blocked',
    message: 'The app address is blocked by the server’s network rules.',
  }),
  'sources.app.resolve': msg({
    id: 'sources.app.resolve',
    message:
      'The app’s address could not be resolved.  Try again after checking the server’s network connection.',
  }),
  'sources.app.connect': msg({
    id: 'sources.app.connect',
    message:
      'The connection to the app failed while reading.  Check the server’s network connection and try again.',
  }),
  'sources.app.tls': msg({
    id: 'sources.app.tls',
    message: 'The app’s secure connection could not be verified.',
  }),
  'sources.app.authenticate': msg({
    id: 'sources.app.authenticate',
    message: 'The app could not verify the key.  Check its permissions and try again.',
  }),
  'sources.app.objectMissing': msg({
    id: 'sources.app.objectMissing',
    message:
      'This object is no longer available from the app.  Check the key’s read permissions and choose an available object.',
  }),
  'sources.app.objectNotAllowed': msg({
    id: 'sources.app.objectNotAllowed',
    message:
      'The key cannot read {object}.{hasPermission, select, true {  Required permissions: {permission}.} other {}}',
  }),
  'sources.app.objectNoFields': msg({
    id: 'sources.app.objectNoFields',
    message: '{object} has no fields to read, so it is left out.',
  }),
  'sources.app.status': msg({
    id: 'sources.app.status',
    message: 'The app returned HTTP {status}.  Check its availability and the key’s read permissions.',
  }),
  'sources.app.rateLimited': msg({
    id: 'sources.app.rateLimited',
    message:
      '{status, select, 503 {The app is still unavailable after retries (HTTP 503).  Wait and try syncing again.} 429 {The app is still limiting requests after retries (HTTP 429).  Wait and try syncing again.} other {The app is still limiting requests after retries.  Wait and try syncing again.}}',
  }),
  'sources.app.notJson': msg({
    id: 'sources.app.notJson',
    message: 'The app returned an answer that could not be read as JSON.',
  }),
  'sources.app.records': msg({
    id: 'sources.app.records',
    message: 'The app’s answer did not contain the expected list of records.',
  }),
  'sources.app.pageLimit': msg({
    id: 'sources.app.pageLimit',
    message: 'The app returned more pages than this source can safely read.',
  }),
  'sources.app.recordLimit': msg({
    id: 'sources.app.recordLimit',
    message: 'The app returned more records than this source can safely read.',
  }),
  'sources.app.pagingLoop': msg({
    id: 'sources.app.pagingLoop',
    message: 'The app returned invalid or repeated paging information.  Try syncing again.',
  }),
  'sources.app.nextElsewhere': msg({
    id: 'sources.app.nextElsewhere',
    message: 'The app’s next page points to another address.  The request was refused to protect your key.',
  }),
  'sources.app.tooLarge': msg({
    id: 'sources.app.tooLarge',
    message: 'The app’s answer exceeded the server’s size limit.',
  }),
  'sources.app.noQueries': msg({
    id: 'sources.app.noQueries',
    message: 'Choose one of the app’s objects to sync.',
  }),
  'sources.app.read': msg({
    id: 'sources.app.read',
    message: 'The app could not be read.  Check its availability and try again.',
  }),
  'sources.app.timeout': msg({
    id: 'sources.app.timeout',
    message: 'The app took too long to answer.  Try again.',
  }),
  'sources.app.discovery': msg({
    id: 'sources.app.discovery',
    message: 'The app returned invalid object or property information.',
  }),
  'sources.app.propertyTooLong': msg({
    id: 'sources.app.propertyTooLong',
    message: 'An app property or paging cursor is too long to request safely.',
  }),
  'sources.app.batchChanged': msg({
    id: 'sources.app.batchChanged',
    message: 'The app’s records changed while their properties were being read.  Try syncing again.',
  }),
  'sources.app.queryOnly': msg({
    id: 'sources.app.queryOnly',
    message: 'App sources allow only reads and GraphQL queries.',
  }),
  'sources.app.graphqlErrors': msg({
    id: 'sources.app.graphqlErrors',
    message: 'The app reported an error while reading its GraphQL query.',
  }),
  'sources.app.pageInfo': msg({
    id: 'sources.app.pageInfo',
    message: 'The app returned invalid GraphQL paging information.',
  }),
};
