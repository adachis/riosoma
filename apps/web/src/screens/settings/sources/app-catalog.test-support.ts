import type { AppCatalogEntry, SourceObject } from '@riosoma/contracts';

export const TEST_APP_MESSAGES = {
  'sources.app.fixture.workspace': 'Workspace code',
  'sources.app.fixture.workspaceHelp': 'Use two to six uppercase letters.',
  'sources.app.fixture.address': 'Account address',
  'sources.app.fixture.addressHelp': 'Use your account on example.com.',
  'sources.app.fixture.region': 'Region',
  'sources.app.fixture.regionHelp': 'Choose the region that holds your records.',
  'sources.app.fixture.note': 'Optional code',
  'sources.app.fixture.noteHelp': 'Use up to four printable characters.',
  'sources.app.fixture.keyHelp': 'Use a key with read access.',
};

const secret = {
  name: 'apiKey',
  helpMessageId: 'sources.app.fixture.keyHelp',
  deniedMessageId: 'sources.app.authenticate',
} as const;

/** Three unrelated catalog entries exercise every setting kind without app-specific rendering. */
export const TEST_APP_CATALOG: readonly AppCatalogEntry[] = [
  {
    id: 'garden',
    name: 'Garden Forms',
    settings: [
      {
        key: 'workspace',
        type: 'text',
        required: true,
        maxLength: 6,
        pattern: '^[A-Z]{2,}$',
        labelMessageId: 'sources.app.fixture.workspace',
        helpMessageId: 'sources.app.fixture.workspaceHelp',
      },
      {
        key: 'address',
        type: 'address',
        required: true,
        domain: 'example.com',
        labelMessageId: 'sources.app.fixture.address',
        helpMessageId: 'sources.app.fixture.addressHelp',
      },
      {
        key: 'region',
        type: 'choice',
        required: true,
        values: ['east', 'west'],
        labelMessageId: 'sources.app.fixture.region',
        helpMessageId: 'sources.app.fixture.regionHelp',
      },
      {
        key: 'note',
        type: 'text',
        required: false,
        maxLength: 4,
        labelMessageId: 'sources.app.fixture.note',
        helpMessageId: 'sources.app.fixture.noteHelp',
      },
    ],
    secret,
    keyUrl: 'https://garden.example.com/keys',
  },
  {
    id: 'harbor',
    name: 'Harbor CRM',
    settings: [
      {
        key: 'address',
        type: 'address',
        required: true,
        domain: 'harbor.example',
        labelMessageId: 'sources.app.fixture.address',
        helpMessageId: 'sources.app.fixture.addressHelp',
      },
      {
        key: 'region',
        type: 'choice',
        required: false,
        values: ['east', 'west'],
        labelMessageId: 'sources.app.fixture.region',
        helpMessageId: 'sources.app.fixture.regionHelp',
      },
    ],
    secret: { ...secret, name: 'token' },
    keyUrl: 'https://harbor.example/settings/keys',
  },
  {
    id: 'orchard',
    name: 'Orchard Records',
    settings: [],
    secret: { ...secret, name: 'password' },
    keyUrl: 'https://orchard.example/keys',
  },
];

export const TEST_APP_OBJECTS: SourceObject[] = [
  { schema: null, name: 'contacts', label: 'Contacts', type: 'endpoint', rowEstimate: null },
  { schema: null, name: 'forms/spring', label: 'Spring registration', type: 'endpoint', rowEstimate: null },
  { schema: null, name: 'custom/plots', label: 'Custom plots', type: 'endpoint', rowEstimate: null },
];
