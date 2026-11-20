import { expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { shortcutFromHref } from './shortcuts';

it('recognizes target addresses without treating tables and other links as shortcuts', () => {
  const database = newId('database');
  const table = newId('table');
  const view = newId('view');
  const dashboard = newId('dashboard');
  const face = newId('interface');
  expect(shortcutFromHref(`/${database}/${table}/${view}`)).toEqual({ kind: 'view', id: view });
  expect(shortcutFromHref(`/${database}/dashboards/${dashboard}`)).toEqual({
    kind: 'dashboard',
    id: dashboard,
  });
  expect(shortcutFromHref(`/${database}/interfaces/${face}`)).toEqual({ kind: 'interface', id: face });
  expect(shortcutFromHref(`/${database}/${table}`)).toBeNull();
  expect(shortcutFromHref('/home/tags/launch')).toBeNull();
});
