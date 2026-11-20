import { APP_CATALOG } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { loadModule } from './loader';

it('fills app key guidance from the catalog and supplies form field anchors', async () => {
  const module = await loadModule('app-sources', 'en-US');
  expect(module?.body).not.toContain('{{app-keys}}');
  for (const app of APP_CATALOG) {
    expect(module?.body).toContain(app.name);
    if (app.secret) {
      expect(module?.body).toContain(app.keyUrl);
      expect(module?.body).toContain(`{{ui:${app.secret.helpMessageId}}}`);
    } else {
      expect(module?.body).toContain('{{ui:sources.app.connectedHelp}}');
      expect(module?.body).not.toContain('undefined');
    }
  }
  expect(module?.meta.anchors).toEqual([
    'sources.app.choose',
    'sources.app.settings',
    'sources.app.key',
    'sources.app.createKey',
    'sources.app.test',
  ]);
  expect(module?.body).toContain('Edits in Riosoma never write to the app');
});

it('includes provider deployment settings directly in bundled app help', async () => {
  const module = await loadModule('app-sources', 'en-US');
  expect(module?.body).toContain('RIOSOMA_GITHUB_OAUTH_CLIENT_ID');
  expect(module?.body).toContain('RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET');
  expect(module?.body).not.toMatch(/\]\((?!https:\/\/|\{\{doc:)[^)]+\)/);
});
