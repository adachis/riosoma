import { coda } from './coda.js';
import { typeform } from './typeform.js';
import { github } from './github.js';
import { xero } from './xero.js';
import { quickbooks } from './quickbooks.js';
import { hubspot } from './hubspot.js';
import { linear } from './linear.js';
import { jotform } from './jotform.js';
import { pipedrive } from './pipedrive.js';
import { jira } from './jira.js';
import { confluence } from './confluence.js';
import { registerAppPresets } from './registry.js';
import { calendly } from './calendly.js';
import { trello } from './trello.js';
import { intercom } from './intercom.js';
import { shopify } from './shopify.js';
import { salesforce } from './salesforce.js';
import { zoom } from './zoom.js';
import { zohoCrm } from './zoho-crm.js';
import { gitlab } from './gitlab.js';
import { okta } from './okta.js';
import { freshdesk } from './freshdesk.js';
import { mailchimp } from './mailchimp.js';

export const APP_PRESETS = registerAppPresets([
  hubspot,
  pipedrive,
  calendly,
  jotform,
  jira,
  confluence,
  linear,
  trello,
  intercom,
  shopify,
  salesforce,
  zoom,
  zohoCrm,
  gitlab,
  okta,
  freshdesk,
  mailchimp,
  coda,
  typeform,
  github,
  xero,
  quickbooks,
]);

export { APP_INSPECTION_TIMEOUT_MS, createAppConnector } from './connector.js';
export type { AppAddressChoice, AppDiscovery, AppDiscoveredObject, AppObject, AppPreset } from './types.js';
