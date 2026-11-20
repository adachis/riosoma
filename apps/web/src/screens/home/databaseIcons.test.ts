import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { faBookOpen, faDatabase } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it } from 'vitest';
import { DATABASE_ICONS, databaseIcon } from './databaseIcons';

describe('database icons', () => {
  it('finds an icon by its name, and shows the database icon for any other', () => {
    expect(databaseIcon('book-open')).toBe(faBookOpen);
    expect(databaseIcon('not-an-icon')).toBe(faDatabase);
    expect(databaseIcon(null)).toBe(faDatabase);
  });

  it('covers every icon a starter template uses', () => {
    const templates = join(import.meta.dirname, '../../../../server/src/templates');
    const icons = readdirSync(templates)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .flatMap((name) => [
        ...readFileSync(join(templates, name), 'utf8').matchAll(/^ {2}icon: '([a-z-]+)'/gm),
      ])
      .map((match) => match[1]!);
    expect(icons.length).toBeGreaterThan(15);
    expect(icons.filter((name) => !DATABASE_ICONS.has(name))).toEqual([]);
  });
});
