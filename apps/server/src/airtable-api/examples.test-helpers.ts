import { expect } from 'vitest';

/**
 * Requests and responses as Airtable's Web API reference gives them in its examples: a table of
 * places to visit, the "Apartment Hunting" base's schema, the list of bases, and `whoami`.  Tests
 * swap the examples' IDs for the ones Riosoma made and expect the same responses, key for key.
 */

export const PLACES = {
  create: {
    request: {
      records: [
        { fields: { Name: 'Union Square', Address: '333 Post St', Visited: true } },
        { fields: { Name: 'Ferry Building', Address: '1 Ferry Building' } },
      ],
    },
    response: {
      records: [
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '333 Post St', Name: 'Union Square', Visited: true },
          id: 'rec560UJdUtocSouk',
        },
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '1 Ferry Building', Name: 'Ferry Building' },
          id: 'rec3lbPRG4aVqkeOQ',
        },
      ],
    },
  },
  get: {
    response: {
      createdTime: '2022-09-12T21:03:48.000Z',
      fields: { Address: '333 Post St', Name: 'Union Square', Visited: true },
      id: 'rec560UJdUtocSouk',
    },
  },
  update: {
    request: {
      records: [
        { fields: { Visited: true }, id: 'rec3lbPRG4aVqkeOQ' },
        { fields: { Address: '333 Post Street' }, id: 'rec560UJdUtocSouk' },
      ],
    },
    response: {
      records: [
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '1 Ferry Building', Name: 'Ferry Building', Visited: true },
          id: 'rec3lbPRG4aVqkeOQ',
        },
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '333 Post Street', Name: 'Union Square', Visited: true },
          id: 'rec560UJdUtocSouk',
        },
      ],
    },
  },
  replace: {
    request: { fields: { Name: 'Union Square', Address: '333 Post St' } },
    response: {
      createdTime: '2022-09-12T21:03:48.000Z',
      fields: { Address: '333 Post St', Name: 'Union Square' },
      id: 'rec560UJdUtocSouk',
    },
  },
  upsert: {
    request: {
      performUpsert: { fieldsToMergeOn: ['Name'] },
      records: [
        { fields: { Name: 'Union Square', Visited: true } },
        { fields: { Name: 'Coit Tower', Address: '1 Telegraph Hill Blvd' } },
      ],
    },
    response: {
      createdRecords: ['recNewPlace000001'],
      records: [
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '333 Post St', Name: 'Union Square', Visited: true },
          id: 'rec560UJdUtocSouk',
        },
        {
          createdTime: '2022-09-12T21:03:48.000Z',
          fields: { Address: '1 Telegraph Hill Blvd', Name: 'Coit Tower' },
          id: 'recNewPlace000001',
        },
      ],
      updatedRecords: ['rec560UJdUtocSouk'],
    },
  },
  destroy: {
    response: {
      records: [
        { deleted: true, id: 'rec560UJdUtocSouk' },
        { deleted: true, id: 'rec3lbPRG4aVqkeOQ' },
      ],
    },
  },
  destroyOne: { response: { deleted: true, id: 'recNewPlace000001' } },
};

export const APARTMENTS = {
  schema: {
    tables: [
      {
        description: 'Apartments to track.',
        fields: [
          {
            description: 'Name of the apartment',
            id: 'fld1VnoyuotSTyxW1',
            name: 'Name',
            type: 'singleLineText',
          },
          {
            id: 'fldoaIqdn5szURHpw',
            name: 'Pictures',
            options: { isReversed: false },
            type: 'multipleAttachments',
          },
          {
            id: 'fldumZe00w09RYTW6',
            name: 'District',
            options: {
              inverseLinkFieldId: 'fldWnCJlo2z6ttT8Y',
              isReversed: false,
              linkedTableId: 'tblK6MZHez0ZvBChZ',
              prefersSingleRecordLink: true,
            },
            type: 'multipleRecordLinks',
          },
        ],
        id: 'tbltp8DGLhqbUmjK1',
        name: 'Apartments',
        primaryFieldId: 'fld1VnoyuotSTyxW1',
        views: [{ id: 'viwQpsuEDqHFqegkp', name: 'Grid view', type: 'grid' }],
      },
      {
        fields: [
          { id: 'fldEVzvQOoULO38yl', name: 'Name', type: 'singleLineText' },
          {
            description: 'Apartments that belong to this district',
            id: 'fldWnCJlo2z6ttT8Y',
            name: 'Apartments',
            options: {
              inverseLinkFieldId: 'fldumZe00w09RYTW6',
              isReversed: false,
              linkedTableId: 'tbltp8DGLhqbUmjK1',
              prefersSingleRecordLink: false,
            },
            type: 'multipleRecordLinks',
          },
        ],
        id: 'tblK6MZHez0ZvBChZ',
        name: 'Districts',
        primaryFieldId: 'fldEVzvQOoULO38yl',
        views: [{ id: 'viwi3KXvrKug2mIBS', name: 'District views', type: 'grid' }],
      },
    ],
  },
};

export const BASES = {
  response: {
    bases: [
      { id: 'appLkNDICXNqxSDhG', name: 'Apartment Hunting', permissionLevel: 'create' },
      { id: 'appSW9R5uCNmRmfl6', name: 'Project Tracker', permissionLevel: 'edit' },
    ],
  },
};

export const WHOAMI = {
  response: {
    id: 'usrL2PNC5o3H4lBEi',
    scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
  },
};

/**
 * An example with its IDs replaced by the ones given, and every `createdTime` taking any time,
 * since records here are made when the test runs.
 */
export function swap<T>(example: T, ids: Readonly<Record<string, string>>): T {
  const walk = (value: unknown, key?: string): unknown => {
    if (key === 'createdTime') return expect.any(String);
    if (typeof value === 'string') return ids[value] ?? value;
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return walk(example) as T;
}
