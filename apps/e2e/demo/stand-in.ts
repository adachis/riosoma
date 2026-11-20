/**
 * A PostgreSQL stand-in for the demo warehouse, so the seed and its browser checks run without a
 * warehouse account.  It makes the same seven tables with the same made-up rows: a film studio's
 * titles, products, retailer accounts, territories, release windows, weekly store sales, and
 * digital transactions.  The tables name the same keys differently and declare no keys at all, as
 * the warehouse's do, and the release schedule's columns are lower-case where the rest are upper.
 */

export const STAND_IN_SCHEMA = 'HOME_ENT';

/** How many rows each table holds, which the warehouse's own tables hold too. */
export const STAND_IN_ROWS = {
  TITLE_MASTER: 128,
  PRODUCT_SKU: 606,
  RETAILER_ACCOUNT: 26,
  TERRITORY_REF: 22,
  RELEASE_SCHEDULE: 11_120,
  WEEKLY_POS_SALES: 27_549,
  DIGITAL_TRANSACTIONS: 6_805,
} as const;

type Value = string | number | null;

const TERRITORIES: Array<[string, string, string, string, number]> = [
  ['US', 'United States', 'North America', 'USD', 1.0],
  ['CA', 'Canada', 'North America', 'CAD', 0.11],
  ['MX', 'Mexico', 'Latin America', 'MXN', 0.05],
  ['BR', 'Brazil', 'Latin America', 'BRL', 0.05],
  ['AR', 'Argentina', 'Latin America', 'ARS', 0.02],
  ['GB', 'United Kingdom', 'Europe', 'GBP', 0.14],
  ['IE', 'Ireland', 'Europe', 'EUR', 0.01],
  ['FR', 'France', 'Europe', 'EUR', 0.09],
  ['DE', 'Germany', 'Europe', 'EUR', 0.12],
  ['ES', 'Spain', 'Europe', 'EUR', 0.05],
  ['IT', 'Italy', 'Europe', 'EUR', 0.05],
  ['NL', 'Netherlands', 'Europe', 'EUR', 0.03],
  ['SE', 'Sweden', 'Europe', 'SEK', 0.02],
  ['PL', 'Poland', 'Europe', 'PLN', 0.02],
  ['AU', 'Australia', 'Asia Pacific', 'AUD', 0.06],
  ['NZ', 'New Zealand', 'Asia Pacific', 'NZD', 0.01],
  ['JP', 'Japan', 'Asia Pacific', 'JPY', 0.1],
  ['KR', 'South Korea', 'Asia Pacific', 'KRW', 0.04],
  ['IN', 'India', 'Asia Pacific', 'INR', 0.03],
  ['SG', 'Singapore', 'Asia Pacific', 'SGD', 0.01],
  ['ZA', 'South Africa', 'Middle East and Africa', 'ZAR', 0.01],
  ['AE', 'United Arab Emirates', 'Middle East and Africa', 'AED', 0.01],
];

const FRANCHISES: Array<[string, string[], string, string]> = [
  [
    'Starfall',
    ['Starfall', 'Starfall: Ember Tide', 'Starfall: The Long Orbit', 'Starfall: Last Light'],
    'Science Fiction',
    'PG-13',
  ],
  [
    'The Night Ferry',
    ['The Night Ferry', 'The Night Ferry: Crossing', 'The Night Ferry: Harbor of Glass'],
    'Thriller',
    'R',
  ],
  [
    'Pip and the Paper Moon',
    [
      'Pip and the Paper Moon',
      'Pip and the Paper Moon 2: Kite Season',
      'Pip and the Paper Moon 3: The Lantern Parade',
    ],
    'Animation',
    'PG',
  ],
  ['Copper Canyon', ['Copper Canyon', 'Copper Canyon: Dust and Thunder'], 'Western', 'PG-13'],
  [
    'Midnight Orchard',
    ['Midnight Orchard', 'Midnight Orchard: Harvest', 'Midnight Orchard: Rootbound'],
    'Horror',
    'R',
  ],
  [
    'Atlas Road',
    ['Atlas Road', 'Atlas Road: Detour', 'Atlas Road: Northbound', 'Atlas Road: The Last Mile'],
    'Action',
    'PG-13',
  ],
  ['The Wren Sisters', ['The Wren Sisters', 'The Wren Sisters Go West'], 'Comedy', 'PG'],
];
const FIRST = [
  'Silver',
  'Quiet',
  'Amber',
  'Hollow',
  'Paper',
  'Winter',
  'Salt',
  'Golden',
  'Crooked',
  'Velvet',
  'Iron',
  'Wild',
  'Glass',
  'Blue',
  'Second',
  'Northern',
  'Lost',
  'Summer',
  'Electric',
  'Marble',
  'Distant',
  'Lucky',
  'Stolen',
  'Gentle',
  'Burning',
  'Little',
  'Broken',
  'Painted',
  'Secret',
  'Midday',
];
const SECOND = [
  'Harbor',
  'Lantern',
  'Meadow',
  'Atlas',
  'Compass',
  'River',
  'Signal',
  'Orchard',
  'Tide',
  'Canyon',
  'Kingdom',
  'Letters',
  'Garden',
  'Empire',
  'Sparrow',
  'Almanac',
  'Station',
  'Daughters',
  'Voyage',
  'Carnival',
  'Lighthouse',
  'Mirror',
  'Parade',
  'Summit',
  'Chorus',
  'Frontier',
  'Promise',
  'Bakery',
  'Circus',
  'Hotel',
];
const GENRES: Array<[string, string]> = [
  ['Drama', 'R'],
  ['Comedy', 'PG-13'],
  ['Family', 'PG'],
  ['Action', 'PG-13'],
  ['Romance', 'PG-13'],
  ['Documentary', 'PG'],
  ['Thriller', 'R'],
  ['Animation', 'PG'],
  ['Science Fiction', 'PG-13'],
  ['Horror', 'R'],
];
const LABELS = [
  'Harbor Light Pictures',
  'Harbor Light Animation',
  'Juniper Street Films',
  'Tall Pine Classics',
];
const FORMATS: Array<[string, string, number, number]> = [
  ['DVD', 'DVD', 19.99, 0.34],
  ['BD', 'Blu-ray', 24.99, 0.27],
  ['4K', '4K Ultra HD', 34.99, 0.14],
  ['EST', 'Digital purchase', 14.99, 0.17],
  ['VOD', 'Digital rental', 5.99, 0.08],
];
const RETAILERS: Array<[string, string, string, string]> = [
  ['Brightway Stores', 'Physical', 'US', 'Tier 1'],
  ['Pelican Mart', 'Physical', 'US', 'Tier 1'],
  ['Northgate Wholesale Club', 'Physical', 'US', 'Tier 1'],
  ['Maple Lane Books and Media', 'Physical', 'CA', 'Tier 2'],
  ['Cinder and Co.', 'Physical', 'GB', 'Tier 2'],
  ['Harrow Street Entertainment', 'Physical', 'GB', 'Tier 1'],
  ['Le Petit Écran', 'Physical', 'FR', 'Tier 2'],
  ['Bergmann Medienhaus', 'Physical', 'DE', 'Tier 1'],
  ['Casa Lumen', 'Physical', 'ES', 'Tier 3'],
  ['Vento Media', 'Physical', 'IT', 'Tier 3'],
  ['Tulip Square', 'Physical', 'NL', 'Tier 3'],
  ['Southern Cross Video', 'Physical', 'AU', 'Tier 2'],
  ['Sakura Disc', 'Physical', 'JP', 'Tier 1'],
  ['Hanbit Media', 'Physical', 'KR', 'Tier 2'],
  ['Mercado Estrella', 'Physical', 'MX', 'Tier 2'],
  ['Aurora Supercentro', 'Physical', 'BR', 'Tier 2'],
  ['Kestrel Online', 'Physical', 'US', 'Tier 1'],
  ['Fjord Elektronik', 'Physical', 'SE', 'Tier 3'],
  ['StreamHouse', 'Digital', 'US', 'Tier 1'],
  ['Luma Play', 'Digital', 'US', 'Tier 1'],
  ['Orbit Video', 'Digital', 'US', 'Tier 1'],
  ['KiteTV Store', 'Digital', 'GB', 'Tier 2'],
  ['Vela Digital', 'Digital', 'ES', 'Tier 3'],
  ['Pocket Cinema', 'Digital', 'JP', 'Tier 2'],
  ['Marigold Movies', 'Digital', 'IN', 'Tier 2'],
  ['Tandem Stream', 'Digital', 'DE', 'Tier 2'],
];
const MANAGERS = [
  'Priya Nair',
  'Marcus Bell',
  'Elena Sokolova',
  'Diego Fuentes',
  'Hannah Okafor',
  'Kenji Watanabe',
  'Sofia Lindqvist',
  'Omar Haddad',
];

const DAY_MS = 86_400_000;
const TODAY = new Date('2026-10-04T00:00:00Z');
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** Every table's rows, from a small seeded generator, so every build makes the same data. */
export function standInRows(weeks = 52): Record<keyof typeof STAND_IN_ROWS, Value[][]> {
  let seed = 20261004;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const between = (low: number, high: number) => low + Math.floor(rand() * (high - low + 1));

  interface Title {
    id: number;
    name: string;
    franchise: string | null;
    genre: string;
    rating: string;
    runtime: number;
    released: string;
    budget: number;
    label: string;
    strength: number;
  }
  const titles: Title[] = [];
  let id = 1001;
  const start = new Date('2019-01-11T00:00:00Z');
  const used = new Set<string>();
  for (const [franchise, names, genre, rating] of FRANCHISES) {
    names.forEach((name, index) => {
      used.add(name);
      titles.push({
        id: id++,
        name,
        franchise,
        genre,
        rating,
        runtime: between(92, 148),
        released: iso(addDays(start, between(0, 400) + index * 620)),
        budget: between(35, 190) * 1_000_000,
        label: index === 0 ? LABELS[0]! : pick(LABELS.slice(0, 2)),
        strength: 1.6 + rand() * 2.2,
      });
    });
  }
  while (titles.length < 128) {
    const name = rand() < 0.5 ? `The ${pick(FIRST)} ${pick(SECOND)}` : `${pick(FIRST)} ${pick(SECOND)}`;
    if (used.has(name)) continue;
    used.add(name);
    const [genre, rating] = pick(GENRES);
    titles.push({
      id: id++,
      name,
      franchise: null,
      genre,
      rating,
      runtime: between(84, 142),
      released: iso(addDays(start, between(0, 2650))),
      budget: between(4, 95) * 1_000_000,
      label: pick(LABELS),
      strength: 0.25 + rand() * rand() * 2.4,
    });
  }

  interface Sku {
    sku: string;
    upc: string;
    titleId: number;
    format: string;
    description: string;
    price: number;
    street: string;
    status: string;
    share: number;
    strength: number;
    streetDate: Date;
  }
  const skus: Sku[] = [];
  let upc = 840214500010;
  for (const title of titles) {
    const theatrical = new Date(`${title.released}T00:00:00Z`);
    for (const [code, description, price, share] of FORMATS) {
      if (code === '4K' && title.strength < 0.7 && rand() < 0.6) continue;
      const street = addDays(
        theatrical,
        code === 'EST' ? between(45, 70) : code === 'VOD' ? between(60, 90) : between(84, 119),
      );
      skus.push({
        sku: `SKU-${String(skus.length + 1).padStart(6, '0')}`,
        upc: String((upc += between(3, 41))),
        titleId: title.id,
        format: code,
        description: `${title.name} (${description})`,
        price: code === '4K' && title.strength > 2.4 ? 39.99 : price,
        street: iso(street),
        status: street > TODAY ? 'Announced' : rand() < 0.06 ? 'Moratorium' : 'Active',
        share,
        strength: title.strength,
        streetDate: street,
      });
    }
  }

  const accounts = RETAILERS.map(([name, channel, country, tier], index) => ({
    id: `A${1001 + index}`,
    name,
    channel,
    country,
    manager: pick(MANAGERS),
    tier,
    weight: tier === 'Tier 1' ? 1 : tier === 'Tier 2' ? 0.45 : 0.18,
  }));
  const territoryShare = new Map(TERRITORIES.map((territory) => [territory[0], territory[4]]));

  // Release windows per title and territory, which a different team loads under its own names.
  const windows: Value[][] = [];
  for (const title of titles) {
    const theatrical = new Date(`${title.released}T00:00:00Z`);
    for (const [territory] of TERRITORIES) {
      if (territoryShare.get(territory)! < 0.03 && rand() < 0.45) continue;
      const lag = territory === 'US' || territory === 'CA' ? 0 : between(0, 35);
      const plan: Array<[string, number, number]> = [
        ['Theatrical', 0, between(40, 75)],
        ['Digital purchase', between(45, 70), 3650],
        ['Digital rental', between(60, 90), 3650],
        ['Physical', between(84, 119), 3650],
        ['Subscription streaming', between(120, 210), between(365, 720)],
      ];
      for (const [name, offset, length] of plan) {
        if (name === 'Subscription streaming' && rand() < 0.3) continue;
        const begins = addDays(theatrical, offset + lag);
        const ends = addDays(begins, length);
        windows.push([
          title.id,
          territory,
          name,
          iso(begins),
          length >= 3650 ? null : iso(ends),
          begins > TODAY ? 'Planned' : ends < TODAY && length < 3650 ? 'Closed' : 'Open',
        ]);
      }
    }
  }

  // Weekly point-of-sale for physical accounts, for weeks ending on Saturdays.
  const pos: Value[][] = [];
  const lastWeek = new Date('2026-09-26T00:00:00Z');
  const physical = accounts.filter((account) => account.channel === 'Physical');
  const digital = accounts.filter((account) => account.channel === 'Digital');
  for (let week = weeks - 1; week >= 0; week -= 1) {
    const ending = addDays(lastWeek, -7 * week);
    const season = 1 + (ending.getUTCMonth() >= 10 ? 0.9 : 0) + (ending.getUTCMonth() === 5 ? 0.2 : 0);
    for (const sku of skus) {
      if (sku.format === 'EST' || sku.format === 'VOD' || sku.streetDate > ending) continue;
      const age = (ending.getTime() - sku.streetDate.getTime()) / (7 * DAY_MS);
      const decay = age < 8 ? 6 * Math.exp(-age / 2.6) + 0.5 : 0.5 * Math.exp(-(age - 8) / 90);
      const base = sku.strength * sku.share * decay * season;
      if (base < 0.02 && rand() < 0.8) continue;
      for (const account of physical) {
        if (rand() > Math.min(0.9, 0.12 + base * account.weight)) continue;
        const units = Math.max(
          1,
          Math.round(
            base * account.weight * (900 + rand() * 3600) * (territoryShare.get(account.country)! + 0.25),
          ),
        );
        const discount = age > 26 ? 0.55 + rand() * 0.2 : 0.78 + rand() * 0.2;
        pos.push([
          iso(ending),
          sku.upc,
          account.id,
          account.country,
          units,
          Number((units * sku.price * discount).toFixed(2)),
          rand() < 0.2 ? Math.round(units * rand() * 0.12) : 0,
        ]);
      }
    }
  }

  // Digital transactions arrive daily from the platforms, in their own vocabulary.
  const transactions: Value[][] = [];
  const days = Math.min(weeks * 7, 180);
  const lastDay = new Date('2026-09-30T00:00:00Z');
  const sold = TERRITORIES.filter((territory) => territory[4] >= 0.03);
  for (let day = days - 1; day >= 0; day -= 1) {
    const date = addDays(lastDay, -day);
    for (const sku of skus) {
      if ((sku.format !== 'EST' && sku.format !== 'VOD') || sku.streetDate > date) continue;
      const age = (date.getTime() - sku.streetDate.getTime()) / (7 * DAY_MS);
      const base =
        sku.strength * (age < 6 ? 3.2 * Math.exp(-age / 2.2) + 0.35 : 0.35 * Math.exp(-(age - 6) / 120));
      for (const platform of digital) {
        if (rand() > Math.min(0.5, 0.015 + base * platform.weight * 0.06)) continue;
        const [territory] = pick(sold);
        const quantity = Math.max(1, Math.round(base * platform.weight * (40 + rand() * 400)));
        transactions.push([
          iso(date),
          sku.upc,
          platform.id,
          territory,
          sku.format === 'EST' ? 'Purchase' : 'Rental',
          quantity,
          Number((quantity * sku.price * 0.7).toFixed(2)),
        ]);
      }
    }
  }

  return {
    TITLE_MASTER: titles.map((title) => [
      title.id,
      title.name,
      title.franchise,
      title.genre,
      title.rating,
      title.runtime,
      title.released,
      title.budget,
      title.label,
    ]),
    PRODUCT_SKU: skus.map((sku) => [
      sku.sku,
      sku.upc,
      sku.titleId,
      sku.format,
      sku.description,
      sku.price,
      sku.street,
      sku.status,
    ]),
    RETAILER_ACCOUNT: accounts.map((account) => [
      account.id,
      account.name,
      account.channel,
      account.country,
      account.manager,
      account.tier,
    ]),
    TERRITORY_REF: TERRITORIES.map((territory) => territory.slice(0, 4) as Value[]),
    RELEASE_SCHEDULE: windows,
    WEEKLY_POS_SALES: pos,
    DIGITAL_TRANSACTIONS: transactions,
  };
}

const COLUMNS: Record<keyof typeof STAND_IN_ROWS, string> = {
  TITLE_MASTER:
    '"TITLE_ID" numeric(10,0) NOT NULL, "TITLE_NAME" varchar(200), "FRANCHISE" varchar(120), "GENRE" varchar(60), "RATING" varchar(10), "RUNTIME_MIN" numeric(4,0), "THEATRICAL_RELEASE_DT" date, "PRODUCTION_BUDGET_USD" numeric(14,0), "STUDIO_LABEL" varchar(120)',
  PRODUCT_SKU:
    '"SKU_NBR" varchar(20) NOT NULL, "UPC" varchar(14), "TTL_ID" numeric(10,0), "FORMAT_CD" varchar(8), "CONFIG_DESC" varchar(260), "SRP_AMT" numeric(8,2), "STREET_DT" date, "SKU_STATUS" varchar(20)',
  RETAILER_ACCOUNT:
    '"ACCT_NO" varchar(10) NOT NULL, "ACCOUNT_NAME" varchar(160), "CHANNEL" varchar(20), "HQ_COUNTRY" varchar(2), "ACCOUNT_MANAGER" varchar(120), "TIER" varchar(10)',
  TERRITORY_REF:
    '"TERRITORY_CODE" varchar(2) NOT NULL, "TERRITORY_NAME" varchar(80), "REGION" varchar(40), "CURRENCY_CD" varchar(3)',
  RELEASE_SCHEDULE:
    '"title_key" numeric(10,0), "territory_cd" varchar(2), "release_window" varchar(40), "start_date" date, "end_date" date, "status" varchar(12)',
  WEEKLY_POS_SALES:
    '"WEEK_ENDING" date, "UPC_CODE" varchar(14), "RETAILER_ACCT" varchar(10), "TERR" varchar(2), "UNITS_SOLD" numeric(10,0), "GROSS_REV_USD" numeric(14,2), "RETURNS_UNITS" numeric(10,0)',
  DIGITAL_TRANSACTIONS:
    '"TXN_DATE" date, "PRODUCT_UPC" varchar(14), "PLATFORM_ID" varchar(10), "COUNTRY" varchar(2), "TXN_TYPE" varchar(12), "QTY" numeric(10,0), "NET_REVENUE_USD" numeric(14,2)',
};

const literal = (value: Value) =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;

/** The statements that make the stand-in, replacing any earlier one under the same schema name. */
export function standInSql(schema = STAND_IN_SCHEMA, weeks = 52): string {
  const rows = standInRows(weeks);
  const statements = [`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, `CREATE SCHEMA "${schema}"`];
  for (const [table, columns] of Object.entries(COLUMNS) as Array<[keyof typeof STAND_IN_ROWS, string]>) {
    statements.push(`CREATE TABLE "${schema}"."${table}" (${columns})`);
    for (let offset = 0; offset < rows[table].length; offset += 1_000)
      statements.push(
        `INSERT INTO "${schema}"."${table}" VALUES ${rows[table]
          .slice(offset, offset + 1_000)
          .map((row) => `(${row.map(literal).join(', ')})`)
          .join(', ')}`,
      );
  }
  return `${statements.join(';\n')};`;
}
