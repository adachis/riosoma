import { newId } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { shareSettings } from './shared-views.js';

it('preserves field choices and copying when an older wildcard embed rule is disabled', () => {
  const fieldIds = [newId('field')];
  const site = `https://*.${newId('field').toLowerCase()}.invalid`;
  expect(shareSettings({ fieldIds, allowCopy: true, embed: { enabled: true, sites: [site] } })).toEqual({
    fieldIds,
    allowCopy: true,
    embed: { enabled: false, sites: [] },
  });
});

it('preserves an exact origin that was already saved', () => {
  const sites = [`https://${newId('field').toLowerCase()}.invalid`];
  const settings = { fieldIds: [newId('field')], allowCopy: false, embed: { enabled: true, sites } };
  expect(shareSettings(settings)).toEqual(settings);
});

it('still shares as little as possible when stored field settings are malformed', () => {
  expect(
    shareSettings({ fieldIds: ['invalid'], allowCopy: true, embed: { enabled: true, sites: [] } }),
  ).toEqual({
    fieldIds: [],
    allowCopy: false,
    embed: { enabled: false, sites: [] },
  });
});
