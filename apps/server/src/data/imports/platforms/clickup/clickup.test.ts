import { vi } from 'vitest';
import type * as Logger from '../../../../logger.js';
import { taskImportSuite } from '../../../../test/platforms/task-imports.js';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

taskImportSuite(
  'clickup',
  {
    short_text: 'text',
    text: 'longText',
    url: 'url',
    email: 'email',
    phone: 'phone',
    checkbox: 'checkbox',
    number: 'number',
    currency: 'currency',
    date: 'date',
    drop_down: 'singleSelect',
    labels: 'multipleSelect',
    users: 'text',
    attachment: 'attachment',
    files: 'attachment',
    emoji: 'rating',
    manual_progress: 'number',
    automatic_progress: 'number',
    progress: 'number',
    location: 'json',
    formula: 'json',
    rollup: 'json',
    voting: 'json',
    future_type: 'json',
  },
  logs.lines,
);
