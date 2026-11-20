import { choices, grid, type StarterTemplate } from './types.js';

const companies = [
  'Juniper Studio',
  'Harbor Supply',
  'Maple Works',
  'Cedar Market',
  'Summit Outfitters',
  'Willow Design',
  'Beacon Foods',
  'Riverbend Goods',
  'Orchard Labs',
  'Meadow Press',
  'Northstar Bikes',
  'Copper Kitchen',
  'Elm Services',
  'Pine Workshop',
  'Lakeview Retail',
];
export const salesPipeline: StarterTemplate = {
  id: 'sales-pipeline',
  name: 'Sales pipeline',
  description: 'Connect companies, contacts, and opportunities with a clear view of expected revenue.',
  icon: 'handshake',
  color: 'green',
  category: 'work',
  tables: [
    {
      key: 'companies',
      name: 'Companies',
      fields: [
        { key: 'name', name: 'Company', type: 'text' },
        { key: 'website', name: 'Website', type: 'url' },
        {
          key: 'industry',
          name: 'Industry',
          type: 'singleSelect',
          options: choices('Retail', 'Services', 'Manufacturing'),
        },
        {
          key: 'contacts',
          name: 'Contacts',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'contacts', inverseFieldKey: 'company' },
        },
        {
          key: 'deals',
          name: 'Deals',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'deals', inverseFieldKey: 'company' },
        },
      ],
      views: [grid],
      records: companies.map((name, i) => ({
        key: `company-${i}`,
        values: {
          name,
          website: `https://company-${i + 1}.example.com`,
          industry: ['Retail', 'Services', 'Manufacturing'][i % 3]!,
        },
      })),
    },
    {
      key: 'contacts',
      name: 'Contacts',
      fields: [
        { key: 'name', name: 'Contact', type: 'text' },
        { key: 'email', name: 'Email', type: 'email' },
        {
          key: 'company',
          name: 'Company',
          type: 'link',
          options: { linkedTableKey: 'companies', inverseFieldKey: 'contacts', prefersSingle: true },
        },
        { key: 'notes', name: 'Notes', type: 'longText' },
      ],
      views: [grid],
      records: companies.map((name, i) => ({
        key: `contact-${i}`,
        values: {
          name: `${name} purchasing desk`,
          email: `purchasing@company-${i + 1}.example.com`,
          company: [`company-${i}`],
          notes: 'Send a concise proposal with pricing and delivery dates.',
        },
      })),
    },
    {
      key: 'deals',
      name: 'Deals',
      fields: [
        { key: 'name', name: 'Deal', type: 'text' },
        {
          key: 'company',
          name: 'Company',
          type: 'link',
          options: { linkedTableKey: 'companies', inverseFieldKey: 'deals', prefersSingle: true },
        },
        {
          key: 'stage',
          name: 'Stage',
          type: 'singleSelect',
          options: choices('Discovery', 'Proposal', 'Won', 'Negotiation', 'Lost'),
        },
        { key: 'amount', name: 'Amount', type: 'currency', options: { code: 'USD' } },
        { key: 'probability', name: 'Probability', type: 'percent' },
        {
          key: 'weighted',
          name: 'Weighted value',
          type: 'formula',
          options: { expression: '{Amount} * {Probability}', precision: 2 },
        },
        { key: 'close', name: 'Close date', type: 'date' },
        {
          key: 'industry',
          name: 'Industry',
          type: 'lookup',
          options: { linkFieldKey: 'company', targetFieldKey: 'industry' },
        },
      ],
      views: [
        grid,
        { key: 'stage', name: 'Pipeline', type: 'kanban', stackField: 'stage' },
        { key: 'close', name: 'Closing calendar', type: 'calendar', startField: 'close' },
      ],
      records: Array.from({ length: 30 }, (_, i) => ({
        key: `deal-${i}`,
        values: {
          name: `${companies[i % 15]} ${i < 15 ? 'starter order' : 'expansion'}`,
          company: [`company-${i % 15}`],
          stage: ['Discovery', 'Proposal', 'Won', 'Negotiation', 'Lost'][i % 5]!,
          amount: 1500 + i * 750,
          probability: [0.2, 0.5, 1, 0.8, 0][i % 5]!,
          close: { days: i * 2 - 8 },
        },
      })),
    },
  ],
};
