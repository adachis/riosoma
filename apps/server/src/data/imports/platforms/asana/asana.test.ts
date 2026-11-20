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
  'asana',
  {
    text: 'longText',
    enum: 'singleSelect',
    multi_enum: 'multipleSelect',
    number: 'number',
    date: 'date',
    people: 'text',
    id: 'text',
    future_type: 'json',
    currency: 'currency',
    percentage: 'percent',
    formula: 'number',
    custom: 'number',
  },
  logs.lines,
);
