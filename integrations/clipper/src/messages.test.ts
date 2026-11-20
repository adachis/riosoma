import { describe, expect, it } from 'vitest';
import { activate, integrationMessages, message } from '../../../packages/ui/src/integrations/messages';

// Kept apart from the other tests because activating a catalog changes the module's language.
describe('integration strings', () => {
  it('are Lingui descriptors keyed by their own IDs, so extraction collects them', () => {
    for (const [key, descriptor] of Object.entries(integrationMessages)) {
      expect(descriptor.id).toBe(key);
      expect(descriptor.message.trim()).toBe(descriptor.message);
    }
  });
  it('read in American English until a catalog is activated, then in its language', () => {
    expect(message('clipper.save')).toBe('Save page');
    activate('fr', { 'clipper.save': 'Enregistrer la page' });
    expect(message('clipper.save')).toBe('Enregistrer la page');
  });
});
