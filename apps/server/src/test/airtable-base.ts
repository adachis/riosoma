import type { FakeBase, FakeField, FakeRecord } from './fake-airtable.js';

/**
 * A base for Airtable import tests, in the shapes Airtable's API answers with: projects with a
 * field of every type, tasks linked to them both ways and to each other, people linked one way,
 * and a log long enough to take several pages.
 */

/** An ID in Airtable's form: a prefix and 14 letters and digits. */
export function airtableId(
  prefix: 'app' | 'tbl' | 'fld' | 'viw' | 'rec' | 'sel' | 'att' | 'usr',
  name: string,
): string {
  return `${prefix}${name
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 14)
    .padEnd(14, '0')}`;
}

export const BASE_ID = airtableId('app', 'Launch');
const T = {
  projects: airtableId('tbl', 'Projects'),
  tasks: airtableId('tbl', 'Tasks'),
  people: airtableId('tbl', 'People'),
  log: airtableId('tbl', 'Log'),
};

const f = (name: string) => airtableId('fld', name);
export const F = {
  name: f('PName'),
  notes: f('Notes'),
  status: f('Status'),
  tags: f('Tags'),
  budget: f('Budget'),
  share: f('Share'),
  estimate: f('Estimate'),
  score: f('Score'),
  active: f('Active'),
  start: f('Start'),
  due: f('Due'),
  contact: f('Contact'),
  site: f('Site'),
  phone: f('Phone'),
  owner: f('Owner'),
  watchers: f('Watchers'),
  files: f('Files'),
  tasks: f('PTasks'),
  taskCount: f('TaskCount'),
  taskNames: f('TaskNames'),
  hours: f('PHours'),
  label: f('Label'),
  days: f('Days'),
  double: f('Double'),
  ago: f('Ago'),
  brief: f('Brief'),
  code: f('Code'),
  open: f('Open'),
  number: f('Number'),
  created: f('Created'),
  edited: f('Edited'),
  author: f('Author'),
  summary: f('Summary'),
  future: f('Future'),
  taskName: f('TName'),
  taskHours: f('THours'),
  taskProject: f('TProject'),
  blocks: f('Blocks'),
  blockedBy: f('BlockedBy'),
  person: f('TPerson'),
  personName: f('PplName'),
  personEmail: f('PplEmail'),
  logName: f('LogName'),
  logValue: f('LogValue'),
};

const r = (name: string) => airtableId('rec', name);
export const R = {
  website: r('Website'),
  app: r('App'),
  docs: r('Docs'),
  design: r('Design'),
  build: r('Build'),
  plan: r('Plan'),
  ada: r('Ada'),
  bea: r('Bea'),
};

export const V = {
  grid: airtableId('viw', 'ProjectsGrid'),
  doing: airtableId('viw', 'Doing'),
  byBudget: airtableId('viw', 'ByBudget'),
  board: airtableId('viw', 'Board'),
  pictures: airtableId('viw', 'Pictures'),
  calendar: airtableId('viw', 'Calendar'),
  intake: airtableId('viw', 'Intake'),
  plan: airtableId('viw', 'PlanTimeline'),
  chart: airtableId('viw', 'Chart'),
  tasks: airtableId('viw', 'AllTasks'),
  people: airtableId('viw', 'People'),
  log: airtableId('viw', 'LogGrid'),
  recent: airtableId('viw', 'Recent'),
};

export const LOG_RECORDS = 250;

/** The log's records by number, zero-padded so no two IDs come out the same. */
export const logRecord = (number: number) => airtableId('rec', `Log${String(number).padStart(4, '0')}`);
/** Each log entry's name, in an order that has nothing to do with its value. */
export const logName = (number: number) => `Entry ${String((number * 37) % 251).padStart(3, '0')}`;

/** A one-pixel PNG. */
export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export interface BaseOptions {
  /** Where the fake serves files */
  filesUrl: string;
  /** Emails of people who are members here, and one who isn't */
  owner: string;
  stranger: string;
  /** Text that should never survive the import, such as the token */
  echo?: string;
}

const choice = (name: string, color: string) => ({ id: airtableId('sel', name), name, color });

export function launchBase(options: BaseOptions): FakeBase {
  const person = (email: string, name: string) => ({ id: airtableId('usr', name), email, name });
  const owner = person(options.owner, 'Owner');
  const stranger = person(options.stranger, 'Stranger');
  const projectFields: FakeField[] = [
    { id: F.name, name: 'Name', type: 'singleLineText', description: 'What the project is called' },
    {
      id: F.notes,
      name: 'Notes',
      type: 'multilineText',
      ...(options.echo ? { description: `Notes ${options.echo}` } : {}),
    },
    {
      id: F.status,
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: [choice('Todo', 'blueLight2'), choice('Doing', 'cyanBright'), choice('Done', 'greenDark1')],
      },
    },
    {
      id: F.tags,
      name: 'Tags',
      type: 'multipleSelects',
      options: { choices: [choice('Red tag', 'redLight1'), choice('Blue tag', 'blueBright')] },
    },
    { id: F.budget, name: 'Budget', type: 'currency', options: { precision: 2, symbol: '$' } },
    { id: F.share, name: 'Share', type: 'percent', options: { precision: 1 } },
    { id: F.estimate, name: 'Estimate', type: 'duration', options: { durationFormat: 'h:mm:ss' } },
    { id: F.score, name: 'Score', type: 'rating', options: { max: 5, icon: 'heart', color: 'redBright' } },
    { id: F.active, name: 'Active', type: 'checkbox', options: { color: 'greenBright', icon: 'check' } },
    {
      id: F.start,
      name: 'Start',
      type: 'date',
      options: { dateFormat: { name: 'iso', format: 'YYYY-MM-DD' } },
    },
    {
      id: F.due,
      name: 'Due',
      type: 'dateTime',
      options: {
        dateFormat: { name: 'us', format: 'M/D/YYYY' },
        timeFormat: { name: '24hour', format: 'HH:mm' },
        timeZone: 'utc',
      },
    },
    { id: F.contact, name: 'Contact', type: 'email' },
    { id: F.site, name: 'Site', type: 'url' },
    { id: F.phone, name: 'Phone', type: 'phoneNumber' },
    { id: F.owner, name: 'Owner', type: 'singleCollaborator' },
    { id: F.watchers, name: 'Watchers', type: 'multipleCollaborators' },
    { id: F.files, name: 'Files', type: 'multipleAttachments', options: { isReversed: false } },
    {
      id: F.tasks,
      name: 'Tasks',
      type: 'multipleRecordLinks',
      options: {
        linkedTableId: T.tasks,
        inverseLinkFieldId: F.taskProject,
        isReversed: false,
        prefersSingleRecordLink: false,
      },
    },
    {
      id: F.taskCount,
      name: 'Task count',
      type: 'count',
      options: { isValid: true, recordLinkFieldId: F.tasks },
    },
    {
      id: F.taskNames,
      name: 'Task names',
      type: 'multipleLookupValues',
      options: {
        isValid: true,
        recordLinkFieldId: F.tasks,
        fieldIdInLinkedTable: F.taskName,
        result: { type: 'singleLineText' },
      },
    },
    {
      id: F.hours,
      name: 'Hours',
      type: 'rollup',
      options: {
        isValid: true,
        recordLinkFieldId: F.tasks,
        fieldIdInLinkedTable: F.taskHours,
        referencedFieldIds: [],
        result: { type: 'number', options: { precision: 1 } },
      },
    },
    {
      id: F.label,
      name: 'Label',
      type: 'formula',
      options: {
        isValid: true,
        formula: `{${F.name}} & " (" & {${F.status}} & ")"`,
        referencedFieldIds: [F.name, F.status],
        result: { type: 'singleLineText' },
      },
    },
    {
      id: F.days,
      name: 'Days',
      type: 'formula',
      options: {
        isValid: true,
        formula: `DATETIME_DIFF({${F.due}}, {${F.start}}, 'days')`,
        referencedFieldIds: [F.due, F.start],
        result: { type: 'number', options: { precision: 0 } },
      },
    },
    {
      id: F.double,
      name: 'Double',
      type: 'formula',
      options: {
        isValid: true,
        formula: `{${F.budget}} * 2`,
        referencedFieldIds: [F.budget],
        result: { type: 'number', options: { precision: 2 } },
      },
    },
    {
      id: F.ago,
      name: 'Ago',
      type: 'formula',
      options: {
        isValid: true,
        formula: `FROMNOW({${F.start}})`,
        referencedFieldIds: [F.start],
        result: { type: 'singleLineText' },
      },
    },
    { id: F.brief, name: 'Brief', type: 'richText' },
    { id: F.code, name: 'Code', type: 'barcode' },
    { id: F.open, name: 'Open', type: 'button' },
    { id: F.number, name: 'Number', type: 'autoNumber' },
    {
      id: F.created,
      name: 'Created',
      type: 'createdTime',
      options: { result: { type: 'dateTime', options: { timeZone: 'utc' } } },
    },
    {
      id: F.edited,
      name: 'Edited',
      type: 'lastModifiedTime',
      options: { isValid: true, result: { type: 'dateTime' } },
    },
    { id: F.author, name: 'Author', type: 'createdBy' },
    { id: F.summary, name: 'Summary', type: 'aiText', options: { prompt: [], referencedFieldIds: [] } },
    { id: F.future, name: 'Future', type: 'someNewType' },
  ];
  const png = (name: string, size = PIXEL.length) => ({
    id: airtableId('att', name),
    url: `${options.filesUrl}/files/${name}`,
    filename: name,
    size,
    type: 'image/png',
    width: 1,
    height: 1,
  });
  const projects: FakeRecord[] = [
    {
      id: R.website,
      createdTime: '2026-01-01T09:00:00.000Z',
      fields: {
        [F.name]: 'Website',
        [F.notes]: options.echo ? `Line one\nLine two ${options.echo}` : 'Line one\nLine two',
        [F.status]: 'Doing',
        [F.tags]: ['Red tag', 'Blue tag'],
        [F.budget]: 800,
        [F.share]: 0.5,
        [F.estimate]: 5400,
        [F.score]: 2,
        [F.active]: true,
        [F.start]: '2026-01-05',
        [F.due]: '2026-01-20T15:30:00.000Z',
        [F.contact]: 'ada@example.com',
        [F.site]: 'https://example.com',
        [F.phone]: '555-0100',
        [F.owner]: owner,
        [F.watchers]: [owner, stranger],
        [F.files]: [png('pixel.png'), png('big.bin', 5 * 1024 * 1024)],
        [F.tasks]: [R.design, R.build],
        [F.taskCount]: 2,
        [F.taskNames]: ['Design', 'Build'],
        [F.hours]: 5.5,
        [F.label]: 'Website (Doing)',
        [F.days]: 15,
        [F.double]: 1600,
        [F.ago]: '9 months ago',
        [F.brief]: '**Bold** start',
        [F.code]: { text: '12345', type: 'upce' },
        [F.open]: { label: 'Open', url: 'https://example.com/website' },
        [F.number]: 1,
        [F.created]: '2026-01-01T09:00:00.000Z',
        [F.edited]: '2026-03-01T10:00:00.000Z',
        [F.author]: owner,
        [F.summary]: { state: 'generated', value: 'A new site', isStale: false },
        [F.future]: 'something',
      },
    },
    {
      id: R.app,
      createdTime: '2026-01-02T09:00:00.000Z',
      fields: {
        [F.name]: 'App',
        [F.status]: 'Todo',
        [F.tags]: ['Blue tag'],
        [F.budget]: 300,
        [F.share]: 0.1,
        [F.score]: 4,
        [F.start]: '2026-02-01',
        [F.owner]: owner,
        [F.files]: [
          {
            id: airtableId('att', 'meta'),
            url: 'http://169.254.169.254/latest/meta-data',
            filename: 'meta',
            size: 10,
            type: 'text/plain',
          },
          {
            id: airtableId('att', 'inside'),
            url: 'http://files.internal.test/secret.txt',
            filename: 'secret.txt',
            size: 10,
            type: 'text/plain',
          },
        ],
        [F.tasks]: [R.plan],
        [F.taskCount]: 1,
        [F.taskNames]: ['Plan'],
        [F.hours]: 1,
        [F.label]: 'App (Todo)',
        // Airtable's answer here disagrees with what the formula gives, as a check should notice.
        [F.double]: 999,
        [F.ago]: '8 months ago',
        [F.number]: 2,
        [F.created]: '2026-01-02T09:00:00.000Z',
        [F.edited]: '2026-01-01T10:00:00.000Z',
        [F.author]: owner,
      },
    },
    {
      id: R.docs,
      createdTime: '2026-01-03T09:00:00.000Z',
      fields: {
        [F.name]: 'Docs',
        [F.status]: 'Doing',
        [F.tags]: ['Red tag'],
        [F.budget]: 1200.5,
        [F.share]: 0.25,
        [F.estimate]: -60,
        [F.score]: 5,
        [F.start]: '2026-03-01',
        [F.contact]: 'not an email',
        [F.files]: [png('liar.bin', 10)],
        [F.taskCount]: 0,
        [F.hours]: 0,
        [F.label]: 'Docs (Doing)',
        [F.double]: 2401,
        [F.ago]: '7 months ago',
        [F.number]: 3,
        [F.created]: '2026-01-03T09:00:00.000Z',
        [F.edited]: '2026-02-01T10:00:00.000Z',
        [F.author]: owner,
      },
    },
  ];
  const everyProject = [R.website, R.app, R.docs];
  return {
    id: BASE_ID,
    name: 'Launch plan',
    permissionLevel: 'create',
    tables: [
      {
        id: T.projects,
        name: 'Projects',
        ...(options.echo ? { description: `Imported with ${options.echo}` } : {}),
        primaryFieldId: F.name,
        fields: projectFields,
        views: [
          {
            id: V.grid,
            name: 'Grid view',
            type: 'grid',
            visibleFieldIds: projectFields.map((field) => field.id).filter((id) => id !== F.notes),
            records: everyProject,
          },
          { id: V.doing, name: 'Doing', type: 'grid', records: [R.website, R.docs] },
          { id: V.byBudget, name: 'By budget', type: 'grid', records: [R.docs, R.website, R.app] },
          { id: V.board, name: 'Board', type: 'kanban', records: everyProject },
          { id: V.pictures, name: 'Pictures', type: 'gallery', records: everyProject },
          { id: V.calendar, name: 'Calendar', type: 'calendar', records: everyProject },
          { id: V.intake, name: 'Intake', type: 'form' },
          { id: V.plan, name: 'Plan', type: 'timeline', records: everyProject },
          { id: V.chart, name: 'Chart', type: 'block' },
        ],
        records: projects,
      },
      {
        id: T.tasks,
        name: 'Tasks',
        primaryFieldId: F.taskName,
        fields: [
          { id: F.taskName, name: 'Name', type: 'singleLineText' },
          { id: F.taskHours, name: 'Hours', type: 'number', options: { precision: 1 } },
          {
            id: F.taskProject,
            name: 'Project',
            type: 'multipleRecordLinks',
            options: {
              linkedTableId: T.projects,
              inverseLinkFieldId: F.tasks,
              isReversed: false,
              prefersSingleRecordLink: true,
            },
          },
          {
            id: F.blocks,
            name: 'Blocks',
            type: 'multipleRecordLinks',
            options: {
              linkedTableId: T.tasks,
              inverseLinkFieldId: F.blockedBy,
              prefersSingleRecordLink: false,
            },
          },
          {
            id: F.blockedBy,
            name: 'Blocked by',
            type: 'multipleRecordLinks',
            options: { linkedTableId: T.tasks, inverseLinkFieldId: F.blocks, prefersSingleRecordLink: false },
          },
          {
            id: F.person,
            name: 'Person',
            type: 'multipleRecordLinks',
            options: { linkedTableId: T.people, prefersSingleRecordLink: false },
          },
        ],
        views: [{ id: V.tasks, name: 'All tasks', type: 'grid' }],
        records: [
          {
            id: R.design,
            fields: {
              [F.taskName]: 'Design',
              [F.taskHours]: 3,
              [F.taskProject]: [R.website],
              [F.blocks]: [R.build],
              [F.person]: [R.ada],
            },
          },
          {
            id: R.build,
            fields: {
              [F.taskName]: 'Build',
              [F.taskHours]: 2.5,
              [F.taskProject]: [R.website],
              [F.blockedBy]: [R.design],
              [F.person]: [R.bea],
            },
          },
          { id: R.plan, fields: { [F.taskName]: 'Plan', [F.taskHours]: 1, [F.taskProject]: [R.app] } },
        ],
      },
      {
        id: T.people,
        name: 'People',
        primaryFieldId: F.personName,
        fields: [
          { id: F.personName, name: 'Name', type: 'singleLineText' },
          { id: F.personEmail, name: 'Email', type: 'email' },
        ],
        views: [{ id: V.people, name: 'Everyone', type: 'grid' }],
        records: [
          { id: R.ada, fields: { [F.personName]: 'Ada', [F.personEmail]: 'ada@example.com' } },
          { id: R.bea, fields: { [F.personName]: 'Bea', [F.personEmail]: 'bea@example.com' } },
        ],
      },
      {
        id: T.log,
        name: 'Log',
        primaryFieldId: F.logName,
        fields: [
          { id: F.logName, name: 'Entry', type: 'singleLineText' },
          { id: F.logValue, name: 'Value', type: 'number', options: { precision: 0 } },
        ],
        views: [
          { id: V.log, name: 'Grid view', type: 'grid' },
          {
            id: V.recent,
            name: 'Recent',
            type: 'grid',
            records: Array.from({ length: LOG_RECORDS }, (_, index) => logRecord(LOG_RECORDS - index)),
          },
        ],
        records: Array.from({ length: LOG_RECORDS }, (_, index) => ({
          id: logRecord(index + 1),
          fields: { [F.logName]: logName(index + 1), [F.logValue]: index + 1 },
        })),
      },
    ],
  };
}

export const TABLE_IDS = T;

export const CATALOG_ID = airtableId('app', 'Catalog');
const C = {
  products: airtableId('tbl', 'Products'),
  items: airtableId('tbl', 'LineItems'),
  orders: airtableId('tbl', 'Orders'),
  clients: airtableId('tbl', 'Clients'),
};
export const CATALOG_FIELDS = {
  productName: f('ProdName'),
  price: f('Price'),
  productItems: f('ProdItems'),
  itemName: f('ItemName'),
  product: f('ItemProduct'),
  quantity: f('Quantity'),
  unitPrice: f('UnitPrice'),
  lineTotal: f('LineTotal'),
  order: f('ItemOrder'),
  orderName: f('OrderName'),
  orderItems: f('OrderItems'),
  orderTotal: f('OrderTotal'),
  orderNumber: f('OrderNumber'),
  orderClient: f('OrderClient'),
  orderLabel: f('OrderLabel'),
  clientName: f('ClientName'),
  clientOrders: f('ClientOrders'),
  category: f('Category'),
  aisle: f('Aisle'),
  itemCategory: f('ItemCategory'),
  shelf: f('Shelf'),
};

/**
 * A product catalog, the way shops lay theirs out in Airtable: line items linked to a product and
 * an order, a lookup of the product's price, a line total that multiplies that price by the
 * quantity, and an order total that sums its lines' totals.  Formulas also read a link to the
 * order's client, a product's category, and a lookup of that category, by name.
 */
export function catalogBase(): FakeBase {
  const F = CATALOG_FIELDS;
  const link = (
    id: string,
    name: string,
    linkedTableId: string,
    inverseLinkFieldId: string,
    single = false,
  ) => ({
    id,
    name,
    type: 'multipleRecordLinks',
    options: { linkedTableId, inverseLinkFieldId, isReversed: false, prefersSingleRecordLink: single },
  });
  const r = (name: string) => airtableId('rec', name);
  const R = {
    tea: r('Tea'),
    mug: r('Mug'),
    teas: r('Teas'),
    mugs: r('Mugs'),
    moreTea: r('MoreTea'),
    first: r('FirstOrder'),
    second: r('SecondOrder'),
    forrester: r('Forrester'),
    smith: r('SmithJones'),
  };
  const categories = {
    type: 'singleSelect',
    options: {
      choices: [
        { id: airtableId('sel', 'TeaCoffee'), name: 'Tea & Coffee', color: 'greenLight2' },
        { id: airtableId('sel', 'KitchenDining'), name: 'Kitchen, Dining', color: 'blueLight2' },
      ],
    },
  };
  const category = { [R.tea]: 'Tea & Coffee', [R.mug]: 'Kitchen, Dining' };
  const items = [
    { id: R.teas, name: 'Teas', product: R.tea, quantity: 2, price: 4.5, order: R.first },
    { id: R.mugs, name: 'Mugs', product: R.mug, quantity: 1, price: 12, order: R.first },
    { id: R.moreTea, name: 'More tea', product: R.tea, quantity: 3, price: 4.5, order: R.second },
  ];
  return {
    id: CATALOG_ID,
    name: 'Product catalog',
    permissionLevel: 'create',
    tables: [
      {
        id: C.products,
        name: 'Products',
        primaryFieldId: F.productName,
        fields: [
          { id: F.productName, name: 'Name', type: 'singleLineText' },
          { id: F.price, name: 'Price', type: 'currency', options: { precision: 2, symbol: '$' } },
          link(F.productItems, 'Line items', C.items, F.product),
          { id: F.category, name: 'Category', ...categories },
          {
            id: F.aisle,
            name: 'Aisle',
            type: 'formula',
            options: {
              isValid: true,
              formula: `"Aisle: " & {${F.category}}`,
              referencedFieldIds: [F.category],
              result: { type: 'singleLineText' },
            },
          },
        ],
        views: [{ id: airtableId('viw', 'Products'), name: 'Grid view', type: 'grid' }],
        records: [
          {
            id: R.tea,
            fields: {
              [F.productName]: 'Tea',
              [F.price]: 4.5,
              [F.productItems]: [R.teas, R.moreTea],
              [F.category]: category[R.tea],
              [F.aisle]: `Aisle: ${category[R.tea]}`,
            },
          },
          {
            id: R.mug,
            fields: {
              [F.productName]: 'Mug',
              [F.price]: 12,
              [F.productItems]: [R.mugs],
              [F.category]: category[R.mug],
              [F.aisle]: `Aisle: ${category[R.mug]}`,
            },
          },
        ],
      },
      {
        id: C.items,
        name: 'Line items',
        primaryFieldId: F.itemName,
        fields: [
          { id: F.itemName, name: 'Name', type: 'singleLineText' },
          link(F.product, 'Product', C.products, F.productItems, true),
          { id: F.quantity, name: 'Quantity', type: 'number', options: { precision: 0 } },
          {
            id: F.unitPrice,
            name: 'Unit price',
            type: 'multipleLookupValues',
            options: {
              isValid: true,
              recordLinkFieldId: F.product,
              fieldIdInLinkedTable: F.price,
              result: { type: 'currency', options: { precision: 2, symbol: '$' } },
            },
          },
          {
            id: F.lineTotal,
            name: 'Line total',
            type: 'formula',
            options: {
              isValid: true,
              formula: `{${F.unitPrice}} * {${F.quantity}}`,
              referencedFieldIds: [F.unitPrice, F.quantity],
              result: { type: 'currency', options: { precision: 2, symbol: '$' } },
            },
          },
          link(F.order, 'Order', C.orders, F.orderItems, true),
          {
            id: F.itemCategory,
            name: 'Category',
            type: 'multipleLookupValues',
            options: {
              isValid: true,
              recordLinkFieldId: F.product,
              fieldIdInLinkedTable: F.category,
              result: categories,
            },
          },
          {
            id: F.shelf,
            name: 'Shelf',
            type: 'formula',
            options: {
              isValid: true,
              formula: `{${F.itemCategory}} & ": " & {${F.itemName}}`,
              referencedFieldIds: [F.itemCategory, F.itemName],
              result: { type: 'singleLineText' },
            },
          },
        ],
        views: [{ id: airtableId('viw', 'LineItems'), name: 'Grid view', type: 'grid' }],
        records: items.map((item) => ({
          id: item.id,
          fields: {
            [F.itemName]: item.name,
            [F.product]: [item.product],
            [F.quantity]: item.quantity,
            [F.unitPrice]: [item.price],
            [F.lineTotal]: item.price * item.quantity,
            [F.order]: [item.order],
            [F.itemCategory]: [category[item.product]!],
            [F.shelf]: `${category[item.product]}: ${item.name}`,
          },
        })),
      },
      {
        id: C.orders,
        name: 'Orders',
        primaryFieldId: F.orderName,
        fields: [
          { id: F.orderName, name: 'Name', type: 'singleLineText' },
          link(F.orderItems, 'Line items', C.items, F.order),
          {
            id: F.orderTotal,
            name: 'Order total',
            type: 'rollup',
            options: {
              isValid: true,
              recordLinkFieldId: F.orderItems,
              fieldIdInLinkedTable: F.lineTotal,
              referencedFieldIds: [],
              result: { type: 'currency', options: { precision: 2, symbol: '$' } },
            },
          },
          { id: F.orderNumber, name: 'Order Number', type: 'number', options: { precision: 0 } },
          link(F.orderClient, 'Client', C.clients, F.clientOrders, true),
          {
            id: F.orderLabel,
            name: 'Label',
            type: 'formula',
            options: {
              isValid: true,
              formula: `{${F.orderClient}} & " Order #" & {${F.orderNumber}}`,
              referencedFieldIds: [F.orderClient, F.orderNumber],
              result: { type: 'singleLineText' },
            },
          },
        ],
        views: [{ id: airtableId('viw', 'Orders'), name: 'Grid view', type: 'grid' }],
        records: [
          {
            id: R.first,
            fields: {
              [F.orderName]: 'First',
              [F.orderItems]: [R.teas, R.mugs],
              [F.orderTotal]: 21,
              [F.orderNumber]: 420,
              [F.orderClient]: [R.forrester],
              [F.orderLabel]: 'Forrester Legal Partners Order #420',
            },
          },
          {
            id: R.second,
            fields: {
              [F.orderName]: 'Second',
              [F.orderItems]: [R.moreTea],
              [F.orderTotal]: 13.5,
              [F.orderNumber]: 421,
              [F.orderClient]: [R.smith],
              [F.orderLabel]: 'Smith, Jones & Co. Order #421',
            },
          },
        ],
      },
      {
        id: C.clients,
        name: 'Clients',
        primaryFieldId: F.clientName,
        fields: [
          { id: F.clientName, name: 'Name', type: 'singleLineText' },
          link(F.clientOrders, 'Orders', C.orders, F.orderClient),
        ],
        views: [{ id: airtableId('viw', 'Clients'), name: 'Grid view', type: 'grid' }],
        records: [
          {
            id: R.forrester,
            fields: { [F.clientName]: 'Forrester Legal Partners', [F.clientOrders]: [R.first] },
          },
          { id: R.smith, fields: { [F.clientName]: 'Smith, Jones & Co.', [F.clientOrders]: [R.second] } },
        ],
      },
    ],
  };
}
