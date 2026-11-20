import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserStore, CelebrationEngine, memoryStore, type Celebration } from './engine';
import { CELEBRATIONS, QUIET_INTERVAL_MS, type CelebrationName } from './registry';

const MINUTE = 60_000;

/** An engine on a clock the test moves by hand, starting from an arbitrary moment. */
function setup(options: { store?: ReturnType<typeof memoryStore> } = {}) {
  let now = 5_000_000;
  const engine = new CelebrationEngine({
    store: options.store ?? memoryStore(),
    now: () => now,
    random: () => 0,
  });
  const shown: Celebration[] = [];
  engine.subscribe((celebration) => shown.push(celebration));
  return {
    engine,
    shown,
    later(ms: number) {
      now += ms;
    },
  };
}

const person = { userId: 'user-one', level: 'on' as const };
const names = Object.keys(CELEBRATIONS) as CelebrationName[];
const crossings = names.filter((name) => CELEBRATIONS[name].trigger.kind === 'crossing');
const events = names.filter((name) => CELEBRATIONS[name].trigger.kind === 'event');

afterEach(() => localStorage.clear());

describe('the celebration registry', () => {
  it('gives every celebration an ID, a trigger, a size, a rule, and something for Rio to say', () => {
    const ids = new Set<string>();
    for (const name of names) {
      const definition = CELEBRATIONS[name];
      expect(ids.has(definition.id)).toBe(false);
      ids.add(definition.id);
      expect(['small', 'medium', 'large']).toContain(definition.size);
      expect(['crossing', 'event']).toContain(definition.trigger.kind);
      expect('once' in definition.rule || definition.rule.everyMs >= 0).toBe(true);
      expect(definition.lines.length).toBeGreaterThan(0);
      for (const line of definition.lines) expect(line.id).toMatch(/^celebrate\./);
    }
    expect(ids.size).toBe(10);
  });
});

describe('a crossing', () => {
  it.each(crossings)('%s celebrates once when seen crossing, and not on a second crossing', (name) => {
    const { engine, shown, later } = setup();
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: false })).toBe('below');
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: true })).toBe('shown');
    expect(shown.map((celebration) => celebration.name)).toEqual([name]);
    later(2 * QUIET_INTERVAL_MS);
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: false })).toBe('done');
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: true })).toBe('done');
    expect(shown).toHaveLength(1);
  });

  it.each(crossings)('%s stays quiet for data already past the line when first seen', (name) => {
    const { engine, shown, later } = setup();
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: true })).toBe('missed');
    later(2 * QUIET_INTERVAL_MS);
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: false })).toBe('done');
    expect(engine.observe(name, { ...person, key: 'thing-one', reached: true })).toBe('done');
    expect(shown).toEqual([]);
  });

  it('keeps each key apart, so every table gets its own first hundred', () => {
    const { engine, shown, later } = setup();
    for (const key of ['table-one', 'table-two'])
      engine.observe('records100', { ...person, key, reached: false });
    expect(engine.observe('records100', { ...person, key: 'table-one', reached: true })).toBe('shown');
    later(MINUTE);
    expect(engine.observe('records100', { ...person, key: 'table-two', reached: true })).toBe('shown');
    expect(shown.map((celebration) => celebration.key)).toEqual(['table-one', 'table-two']);
  });

  it('can be used up without showing, for a line crossed some other way', () => {
    const { engine, shown } = setup();
    engine.observe('firstTable', { ...person, key: 'you', reached: false });
    expect(engine.retire('firstTable', { userId: 'user-one', key: 'you' })).toBe('missed');
    expect(engine.retire('firstTable', { userId: 'user-one', key: 'you' })).toBe('done');
    expect(engine.observe('firstTable', { ...person, key: 'you', reached: true })).toBe('done');
    expect(shown).toEqual([]);
  });

  it('remembers what one person saw apart from what another did', () => {
    const { engine } = setup();
    engine.observe('firstTable', { ...person, key: 'you', reached: false });
    expect(engine.observe('firstTable', { ...person, userId: 'user-two', key: 'you', reached: true })).toBe(
      'missed',
    );
    expect(engine.observe('firstTable', { ...person, key: 'you', reached: true })).toBe('shown');
  });
});

describe('an event', () => {
  it.each(events)('%s celebrates when it happens, and rests before celebrating again', (name) => {
    const { engine, shown, later } = setup();
    expect(engine.celebrate(name, { ...person, key: 'thing-one' })).toBe('shown');
    later(1000);
    expect(engine.celebrate(name, { ...person, key: 'thing-one' })).not.toBe('shown');
    expect(shown).toHaveLength(1);
  });

  it('lets a finished board celebrate again once an hour has passed', () => {
    const { engine, shown, later } = setup();
    expect(engine.celebrate('kanbanDone', { ...person, key: 'view-one' })).toBe('shown');
    later(30 * MINUTE);
    expect(engine.celebrate('kanbanDone', { ...person, key: 'view-one' })).toBe('resting');
    later(31 * MINUTE);
    expect(engine.celebrate('kanbanDone', { ...person, key: 'view-one' })).toBe('shown');
    expect(shown).toHaveLength(2);
  });

  it('hands the drawing its size, element, cause, and one of Rio’s lines', () => {
    const { engine, shown } = setup();
    const anchor = document.createElement('button');
    engine.celebrate('importClean', { ...person, key: 'table-one', anchor, cause: 'others' });
    expect(shown[0]).toMatchObject({
      name: 'importClean',
      id: 'import-clean',
      size: 'small',
      key: 'table-one',
      anchor,
      cause: 'others',
      line: CELEBRATIONS.importClean.lines[0],
    });
  });
});

describe('the ten minutes between celebrations', () => {
  it('holds back small and medium celebrations for ten minutes after the last one', () => {
    const { engine, shown, later } = setup();
    expect(engine.celebrate('kanbanDone', { ...person, key: 'view-one' })).toBe('shown');
    later(5 * MINUTE);
    expect(engine.celebrate('importClean', { ...person, key: 'table-one' })).toBe('limited');
    expect(engine.celebrate('kanbanDone', { ...person, key: 'view-two' })).toBe('limited');
    later(5 * MINUTE);
    expect(engine.celebrate('checklistComplete', { ...person, key: 'view-one:field-one' })).toBe('shown');
    expect(shown.map((celebration) => celebration.name)).toEqual(['kanbanDone', 'checklistComplete']);
  });

  it('never holds back a large one, and a large one starts the ten minutes again', () => {
    const { engine, shown, later } = setup();
    engine.observe('records100', { ...person, key: 'table-one', reached: false });
    engine.observe('records1000', { ...person, key: 'table-one', reached: false });
    expect(engine.celebrate('importClean', { ...person, key: 'table-one' })).toBe('shown');
    later(MINUTE);
    expect(engine.observe('records100', { ...person, key: 'table-one', reached: true })).toBe('shown');
    later(MINUTE);
    expect(engine.observe('records1000', { ...person, key: 'table-one', reached: true })).toBe('shown');
    later(9 * MINUTE);
    expect(engine.celebrate('importClean', { ...person, key: 'table-two' })).toBe('limited');
    expect(shown.map((celebration) => celebration.size)).toEqual(['small', 'large', 'large']);
  });

  it('uses up a held-back first, so it doesn’t turn up late', () => {
    const { engine, shown, later } = setup();
    engine.observe('syncFirstSuccess', { ...person, key: 'table-one', reached: false });
    engine.celebrate('kanbanDone', { ...person, key: 'view-one' });
    expect(engine.observe('syncFirstSuccess', { ...person, key: 'table-one', reached: true })).toBe(
      'limited',
    );
    later(2 * QUIET_INTERVAL_MS);
    expect(engine.observe('syncFirstSuccess', { ...person, key: 'table-one', reached: true })).toBe('done');
    expect(shown).toHaveLength(1);
  });
});

describe('the person’s setting', () => {
  it('keeps only small celebrations when set to Quieter', () => {
    const { engine, shown, later } = setup();
    const quieter = { ...person, level: 'quieter' as const };
    expect(engine.celebrate('kanbanDone', { ...quieter, key: 'view-one' })).toBe('quieter');
    engine.observe('records100', { ...quieter, key: 'table-one', reached: false });
    expect(engine.observe('records100', { ...quieter, key: 'table-one', reached: true })).toBe('quieter');
    expect(engine.celebrate('importClean', { ...quieter, key: 'table-one' })).toBe('shown');
    later(2 * QUIET_INTERVAL_MS);
    expect(engine.celebrate('checklistComplete', { ...quieter, key: 'view-one:field-one' })).toBe('shown');
    expect(shown.map((celebration) => celebration.size)).toEqual(['small', 'small']);
  });

  it('shows nothing when Off, and turning them back on doesn’t bring back a moment that passed', () => {
    const { engine, shown, later } = setup();
    const off = { ...person, level: 'off' as const };
    engine.observe('firstTable', { ...off, key: 'you', reached: false });
    expect(engine.observe('firstTable', { ...off, key: 'you', reached: true })).toBe('off');
    expect(engine.celebrate('importClean', { ...off, key: 'table-one' })).toBe('off');
    later(MINUTE);
    expect(engine.observe('firstTable', { ...person, key: 'you', reached: true })).toBe('done');
    // Nothing showed, so the ten minutes never started.
    expect(engine.celebrate('importClean', { ...person, key: 'table-two' })).toBe('shown');
    expect(shown.map((celebration) => celebration.name)).toEqual(['importClean']);
  });
});

describe('what a device remembers', () => {
  it('keeps each person’s memory in browser storage, shared by every tab', () => {
    let now = 9_000_000;
    const first = new CelebrationEngine({ store: browserStore(), now: () => now });
    first.observe('bookingFirst', { ...person, key: 'page-one', reached: false });
    const second = new CelebrationEngine({ store: browserStore(), now: () => now });
    now += MINUTE;
    expect(second.observe('bookingFirst', { ...person, key: 'page-one', reached: true })).toBe('shown');
    expect(first.observe('bookingFirst', { ...person, key: 'page-one', reached: true })).toBe('done');
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('rio.celebrations.user-one');
  });

  it('starts over from storage it can’t read, rather than failing', () => {
    localStorage.setItem('rio.celebrations.user-one', '{not json');
    const engine = new CelebrationEngine({ store: browserStore() });
    expect(engine.celebrate('importClean', { ...person, key: 'table-one' })).toBe('shown');
  });

  it('keeps working without storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    try {
      const engine = new CelebrationEngine({ store: browserStore() });
      engine.observe('formFirstResponse', { ...person, key: 'view-one', reached: false });
      expect(engine.observe('formFirstResponse', { ...person, key: 'view-one', reached: true })).toBe(
        'shown',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forgets the oldest keys once it holds a few hundred', () => {
    const store = memoryStore();
    const { engine, later } = setup({ store });
    for (let index = 0; index < 450; index++) {
      engine.observe('records100', { ...person, key: `table-${index}`, reached: false });
      later(1);
    }
    const memory = store.read('user-one');
    expect(Object.keys(memory.below)).toHaveLength(400);
    expect(memory.below['records-100:table-449']).toBeDefined();
    expect(memory.below['records-100:table-0']).toBeUndefined();
  });
});
