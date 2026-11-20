import { describe, expect, it } from 'vitest';
import { RestEndpoint } from '@riosoma/contracts';
import { documentText, fieldLabels, projectValues } from './values.js';
import type { AppObject } from './types.js';

const values: NonNullable<AppObject['values']> = {
  member: 'fields',
  labels: {
    endpoint: RestEndpoint.parse({ name: 'fields' }),
    id: 'id',
    name: 'name',
    pattern: '^custom_[0-9]+$',
  },
  richText: 'atlassian-document',
};

describe('record field projection', () => {
  it('assigns deterministic, unique names across duplicates, truncation, native IDs, and generated suffixes', () => {
    const records = [
      { id: 'summary', name: 'Summary' },
      { id: 'custom_1', name: 'Score' },
      { id: 'custom_2', name: 'Score' },
      { id: 'custom_3', name: 'Score (custom_1)' },
      { id: 'custom_4', name: 'summary' },
      { id: 'custom_5', name: 'Long'.repeat(100) },
      { id: 'custom_6', name: 'Long'.repeat(100) },
    ];
    const labels = fieldLabels(records, values);
    expect(fieldLabels([...records].reverse(), values)).toEqual(labels);
    expect(labels.get('custom_1')).toBe('Score (custom_1)');
    expect(labels.get('custom_2')).toBe('Score (custom_2)');
    expect(labels.get('custom_3')).toBe('Score (custom_1) (custom_3)');
    expect(labels.get('custom_4')).toBe('summary (custom_4)');
    expect(new Set(labels.values()).size).toBe(labels.size);
    expect([...labels.values()].every((name) => `fields.${name}`.length <= 255)).toBe(true);
  });

  it.each([
    {},
    [{ id: 'custom_1' }],
    [{ id: 'custom_1', name: '' }],
    [{ id: 'custom_1', name: 'Name\n' }],
    [
      { id: 'custom_1', name: 'One' },
      { id: 'custom_1', name: 'Two' },
    ],
  ])('refuses invalid metadata without retaining external words: %s', (document) => {
    expect(() => fieldLabels(document, values)).toThrow('sources.app.discovery');
  });

  it('keeps block boundaries, inline cards, mentions, emoji, and hard breaks in document text', () => {
    expect(
      documentText({
        type: 'doc',
        version: 1,
        content: [
          { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'mention', attrs: { text: '@Reader' } },
              { type: 'text', text: ' ' },
              { type: 'emoji', attrs: { shortName: ':wave:' } },
              { type: 'hardBreak' },
              { type: 'inlineCard', attrs: { url: 'https://example.test' } },
            ],
          },
          { type: 'codeBlock', content: [{ type: 'text', text: '  Indented' }] },
        ],
      }),
    ).toBe('Title\n@Reader :wave:\nhttps://example.test\n  Indented');
    expect(documentText({ type: 'doc', version: 1, content: [] })).toBe('');
  });

  it('projects nested documents and custom fields without changing paging, keys, or ordinary JSON', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }],
    };
    const document = {
      nextPageToken: 'next',
      issues: [
        {
          id: 'one',
          fields: { custom_1: doc, nested: { docs: [doc], ordinary: { value: 3 } }, empty: null },
        },
      ],
    };
    expect(projectValues(document, 'issues', values, new Map([['custom_1', 'Notes']]))).toEqual({
      nextPageToken: 'next',
      issues: [
        {
          id: 'one',
          fields: { Notes: 'Text', nested: { docs: ['Text'], ordinary: { value: 3 } }, empty: null },
        },
      ],
    });
    expect(() => projectValues({}, 'issues', values, new Map())).toThrow('sources.app.records');
  });

  it.each([
    [Date.UTC(2026, 9, 14), '2026-10-14'],
    [Date.UTC(2026, 9, 14, 23, 30), '2026-10-14'],
    [0, '1970-01-01'],
  ])('keeps status labels and inline dates in UTC for timestamp %s', (timestamp, date) => {
    expect(
      documentText({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'State: ' },
              { type: 'status', attrs: { text: 'Approved', color: 'green' } },
              { type: 'hardBreak' },
              { type: 'text', text: 'Due: ' },
              { type: 'date', attrs: { timestamp: String(timestamp) } },
            ],
          },
        ],
      }),
    ).toBe(`State: Approved\nDue: ${date}`);
  });

  it.each([
    { type: 'status', attrs: {} },
    { type: 'status', attrs: { text: {} } },
    { type: 'date', attrs: {} },
    { type: 'date', attrs: { timestamp: '' } },
    { type: 'date', attrs: { timestamp: null } },
    { type: 'date', attrs: { timestamp: 'invalid' } },
    { type: 'date', attrs: { timestamp: '8640000000000001' } },
  ])('keeps surrounding text when inline attributes are malformed: %s', (node) => {
    expect(
      documentText({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Before ' }, node, { type: 'text', text: ' after' }],
          },
        ],
      }),
    ).toBe('Before  after');
  });

  it('refuses an unlisted field that would overwrite a discovered display name', () => {
    expect(() =>
      projectValues(
        { issues: [{ fields: { custom_1: 'First', Notes: 'Second' } }] },
        'issues',
        values,
        new Map([['custom_1', 'Notes']]),
      ),
    ).toThrow('sources.app.discovery');
  });
});
