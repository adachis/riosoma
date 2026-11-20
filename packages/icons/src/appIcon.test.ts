import { expect, it } from 'vitest';
import { appIcon } from './appIcon';

it('uses bundled brands when their names match and a plain app icon otherwise', () => {
  expect(appIcon('hubspot', 'HubSpot').prefix).toBe('fab');
  expect(appIcon('unknown-app', 'HubSpot').iconName).toBe('hubspot');
  expect(appIcon('garden', 'Garden Forms').iconName).toBe('window-maximize');
});
