import type { INodeProperties } from 'n8n-workflow';
import { databaseLocator, tableLocator } from '../../shared/metadata';

const record = (...operation: string[]) => ({ show: { resource: ['record'], operation } });

const DEFAULT_FILTER = `{
  "conjunction": "and",
  "conditions": [
    { "field": "Name", "operator": "contains", "value": "" }
  ]
}`;

/** The field mapper for writes.  Values map by field name, from the item or set one by one. */
function columns(operation: 'create' | 'update' | 'upsert'): INodeProperties {
  return {
    displayName: 'Fields',
    name: 'columns',
    type: 'resourceMapper',
    noDataExpression: true,
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    typeOptions: {
      loadOptionsDependsOn: ['table.value'],
      resourceMapper: {
        resourceMapperMethod: 'getColumns',
        mode: operation === 'upsert' ? 'upsert' : 'add',
        fieldWords: { singular: 'field', plural: 'fields' },
        // An update changes only the fields added to it, so none are there to start with.
        addAllFields: operation !== 'update',
        multiKeyMatch: false,
        supportAutoMap: true,
        ...(operation === 'upsert'
          ? {
              matchingFieldsLabels: {
                title: 'Field to Match On',
                description: 'The field whose value finds the record to update',
                hint: 'A record with the same value is updated, and a new one is created when none has it',
              },
            }
          : {}),
      },
    },
    displayOptions: record(operation),
  };
}

const outputOptions: INodeProperties[] = [
  {
    displayName: 'Nest Fields',
    name: 'nestFields',
    type: 'boolean',
    default: false,
    description:
      'Whether to put the fields under "fields" beside the record\'s ID, which keeps a field named id or createdTime',
  },
];

const readOptions: INodeProperties[] = [
  {
    displayName: 'Field Names or IDs',
    name: 'fields',
    type: 'multiOptions',
    typeOptions: { loadOptionsMethod: 'getFields', loadOptionsDependsOn: ['table.value'] },
    default: [],
    description:
      'Only these fields, rather than every field you can see.  Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
  },
  ...outputOptions,
  {
    displayName: 'Values As Text',
    name: 'valuesAsText',
    type: 'boolean',
    default: false,
    description:
      "Whether to return each value as text, the way Riosoma shows it, in the workflow's time zone",
  },
];

export const properties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    options: [
      { name: 'Database', value: 'database' },
      { name: 'Record', value: 'record' },
      { name: 'Table', value: 'table' },
    ],
    default: 'record',
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['database'] } },
    options: [
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'List the databases the token can reach',
        action: 'Get many databases',
      },
    ],
    default: 'getAll',
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['table'] } },
    options: [
      {
        name: 'Get Many',
        value: 'getAll',
        description: "List a database's tables with their fields and views",
        action: 'Get many tables',
      },
    ],
    default: 'getAll',
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['record'] } },
    options: [
      { name: 'Create', value: 'create', description: 'Add a record', action: 'Create a record' },
      {
        name: 'Create or Update',
        value: 'upsert',
        description: 'Update the record whose field matches a value, or create one when none does',
        action: 'Create or update a record',
      },
      {
        name: 'Delete',
        value: 'delete',
        description: 'Move a record to the trash',
        action: 'Delete a record',
      },
      { name: 'Get', value: 'get', description: 'Get a record by its ID', action: 'Get a record' },
      {
        name: 'Search',
        value: 'search',
        description: "Find records by a field's value or a filter",
        action: 'Search records',
      },
      {
        name: 'Update',
        value: 'update',
        description: 'Change the fields you set and leave the rest',
        action: 'Update a record',
      },
    ],
    default: 'search',
  },
  { ...databaseLocator, displayOptions: { show: { resource: ['table', 'record'] } } },
  { ...tableLocator, displayOptions: { show: { resource: ['record'] } } },
  {
    displayName: 'Record ID',
    name: 'recordId',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'rec0123456789abcd',
    description: "The record's ID, such as the id an earlier Riosoma node returned",
    displayOptions: record('get', 'update', 'delete'),
  },
  {
    displayName: 'Filter By',
    name: 'filterBy',
    type: 'options',
    default: 'none',
    options: [
      { name: 'No Filter', value: 'none', description: 'Every record, or every record in the view' },
      { name: 'Field Value', value: 'field', description: 'Records whose field equals a value' },
      {
        name: 'Filter (JSON)',
        value: 'filter',
        description: "A filter group in the REST API's form, with fields by name or ID",
      },
    ],
    displayOptions: record('search'),
  },
  {
    displayName: 'Field Name or ID',
    name: 'matchField',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getMatchFields', loadOptionsDependsOn: ['table.value'] },
    default: '',
    required: true,
    description:
      'The field to compare.  Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: { show: { resource: ['record'], operation: ['search'], filterBy: ['field'] } },
  },
  {
    displayName: 'Value',
    name: 'matchValue',
    type: 'string',
    default: '',
    required: true,
    description:
      'The value to find.  Text and option names match without regard to case, and dates by the day.',
    displayOptions: { show: { resource: ['record'], operation: ['search'], filterBy: ['field'] } },
  },
  {
    displayName: 'Filter',
    name: 'filter',
    type: 'json',
    default: DEFAULT_FILTER,
    required: true,
    description:
      'A group of conditions joined by "and" or "or".  Each condition names a field by name or ID, an operator such as is, contains, eq, gt, or isEmpty, and a value.',
    displayOptions: { show: { resource: ['record'], operation: ['search'], filterBy: ['filter'] } },
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: record('search'),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1 },
    default: 50,
    description: 'Max number of results to return',
    displayOptions: { show: { resource: ['record'], operation: ['search'], returnAll: [false] } },
  },
  columns('create'),
  columns('update'),
  columns('upsert'),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: record('search'),
    options: [
      ...readOptions,
      {
        displayName: 'Sort',
        name: 'sort',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add sort',
        default: {},
        options: [
          {
            displayName: 'Sort',
            name: 'property',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'field',
                type: 'options',
                typeOptions: {
                  loadOptionsMethod: 'getSortableFields',
                  loadOptionsDependsOn: ['table.value'],
                },
                default: '',
                description:
                  'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              {
                displayName: 'Direction',
                name: 'direction',
                type: 'options',
                options: [
                  { name: 'Ascending', value: 'asc' },
                  { name: 'Descending', value: 'desc' },
                ],
                default: 'asc',
              },
            ],
          },
        ],
      },
      {
        displayName: 'View Name or ID',
        name: 'view',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getViews', loadOptionsDependsOn: ['table.value'] },
        default: '',
        description:
          'Apply a view\'s filter and fields, with its sorts after yours.  Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: record('get'),
    options: readOptions,
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: record('create', 'update', 'upsert'),
    options: [
      {
        displayName: 'Ignore Unknown Fields',
        name: 'ignoreUnknownFields',
        type: 'boolean',
        default: false,
        description:
          'Whether to leave out values whose names match no field, instead of stopping.  The id and createdTime of an earlier Riosoma node are always left out.',
      },
      ...outputOptions,
      {
        displayName: 'Send Empty Values',
        name: 'sendEmptyValues',
        type: 'boolean',
        default: false,
        description:
          'Whether a field set below with an empty value clears the field.  Otherwise empty values are left out, and Riosoma keeps what the field holds.',
      },
      {
        displayName: 'Typecast',
        name: 'typecast',
        type: 'boolean',
        default: false,
        description:
          "Whether Riosoma reads text as numbers, checkboxes, and dates, and adds select options it doesn't have yet.  Adding options takes the Creator or Owner role.",
      },
    ],
  },
];
