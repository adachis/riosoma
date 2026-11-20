import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const object = (name: string): AppObject => ({
  name,
  key: 'id',
  endpoint: RestEndpoint.parse({
    name,
    path: `/admin/api/2026-10/${name}.json`,
    query: [
      { name: 'limit', value: '250' },
      ...(name === 'orders' ? [{ name: 'status', value: 'any' }] : []),
    ],
    records: name,
    paging: { style: 'link-header' },
  }),
});

const products = object('products');

export const shopify: AppPreset = {
  catalog: {
    id: 'shopify',
    name: 'Shopify',
    settings: [
      {
        key: 'store',
        type: 'address',
        required: true,
        domain: 'myshopify.com',
        allowBareName: true,
        subdomainRequired: true,
        labelMessageId: 'sources.app.shopify.storeLabel',
        helpMessageId: 'sources.app.shopify.storeHelp',
        requiredMessageId: 'sources.app.shopify.storeRequired',
        invalidMessageId: 'sources.app.shopify.storeInvalid',
        addressMessageIds: {
          invalid: 'sources.app.shopify.storeInvalid',
          https: 'sources.app.shopify.storeHttps',
          host: 'sources.app.shopify.storeHost',
          credentials: 'sources.app.shopify.storeCredentials',
          port: 'sources.app.shopify.storePort',
          path: 'sources.app.shopify.storePath',
          query: 'sources.app.shopify.storeQuery',
          fragment: 'sources.app.shopify.storeFragment',
        },
      },
    ],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.shopify.tokenHelp',
      deniedMessageId: 'sources.app.shopify.deniedToken',
    },
    keyUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
  },
  target: {
    address: { setting: 'store', domain: 'myshopify.com' },
    auth: { method: 'header', name: 'X-Shopify-Access-Token' },
    // Standard REST plans refill two requests per second.  This pace avoids exhausting that budget.
    // Shopify asks new public apps to use GraphQL.  Custom apps like this one may still use REST.
    // https://shopify.dev/docs/api/admin-rest
    requestsPerSecond: 2,
  },
  // Product variants, options, and images keep the API source's list representation.
  // A separate variants object would need the frame to extract child records from products.
  objects: [
    products,
    ...['custom_collections', 'smart_collections', 'customers', 'orders', 'draft_orders'].map(object),
  ],
  // Locations use singular error, while these objects use errors.  The frame cannot declare both
  // permission fields, so locations are omitted until it can name their read_locations scope.
  // Shop information requires no object read scope, so limited tokens can still authenticate.
  test: {
    name: 'shop',
    key: 'id',
    endpoint: RestEndpoint.parse({ name: 'shop', path: '/admin/api/2026-10/shop.json' }),
  },
  permissionDenied: {
    names: { path: 'errors', pattern: /\b(read_[a-z_]+)\b/ },
  },
};
