import { describe, expect, it } from 'vitest';
import {
  IngestTableSettings,
  IngestField,
  IngestOrganizationSettings,
  OrgSettings,
  INGEST_PROCESS_FIELDS,
  newId,
} from './index.js';
const fieldId = newId('field');
const setting = {
  state: 'setup',
  ownerId: null,
  rowMeaning: 'One order',
  identity: ['order'],
  fields: [{ key: 'order', fieldId, meaning: 'The order number', required: true }],
  originals: { keepDays: null },
  revision: 0,
};
describe('ingest metadata', () => {
  it('defaults original access and replies, and checks stable keys and identity fields', () => {
    expect(IngestTableSettings.parse(setting)).toMatchObject({
      reply: true,
      originals: { readOnlyAccess: false },
    });
    expect(IngestTableSettings.safeParse({ ...setting, identity: ['missing'] }).success).toBe(false);
    expect(IngestTableSettings.safeParse({ ...setting, identity: ['order', 'order'] }).success).toBe(false);
    expect(
      IngestTableSettings.safeParse({ ...setting, fields: [setting.fields[0], setting.fields[0]] }).success,
    ).toBe(false);
    expect(IngestTableSettings.safeParse({ ...setting, state: 'live' }).success).toBe(false);
    expect(IngestTableSettings.safeParse({ ...setting, state: 'live', ownerId: newId('user') }).success).toBe(
      true,
    );
  });
  it('has exactly five fixed process fields and allows distinct stable data keys', () => {
    expect(INGEST_PROCESS_FIELDS).toEqual({
      needsReview: 'checkbox',
      reviewNote: 'longText',
      readByAi: 'checkbox',
      source: 'text',
      received: 'date',
    });
    for (const key of Object.keys(INGEST_PROCESS_FIELDS))
      expect(IngestField.safeParse({ key, role: 'process' }).success).toBe(true);
    expect(IngestField.safeParse({ key: 'orders', role: 'process' }).success).toBe(false);
    expect(IngestField.safeParse({ key: 'orderId', role: 'data' }).success).toBe(true);
    expect(IngestField.safeParse({ key: '__proto__', role: 'data' }).success).toBe(false);
  });
  it('starts retention at 90 days and probation at 3 files, and accepts the required choices', () => {
    expect(IngestOrganizationSettings.parse({})).toEqual({ originalKeepDays: 90, probationFiles: 3 });
    expect(OrgSettings.parse({ ingest: {} }).ingest).toEqual({ originalKeepDays: 90, probationFiles: 3 });
    for (const originalKeepDays of [1, 30, 90, 180, 365, 42, 3650, 'forever'])
      expect(IngestOrganizationSettings.safeParse({ originalKeepDays }).success).toBe(true);
    for (const originalKeepDays of [0, -1, 3.2, 3651, 'custom'])
      expect(IngestOrganizationSettings.safeParse({ originalKeepDays }).success).toBe(false);
    for (const probationFiles of [1, 3, 10])
      expect(IngestOrganizationSettings.safeParse({ probationFiles }).success).toBe(true);
    for (const probationFiles of [0, 11, 3.5])
      expect(IngestOrganizationSettings.safeParse({ probationFiles }).success).toBe(false);
  });
});
