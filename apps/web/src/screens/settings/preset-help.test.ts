import { expect, it } from 'vitest';
import organization from '../../../../../docs/modules/administration/admin-roles-and-audit/en-US.md?raw';
import units from '../../../../../docs/modules/administration/org-units/en-US.md?raw';

it.each([
  ['admin-roles-and-audit', organization, '## Apply a policy preset', 'organizationPresets.apply'],
  ['org-units', units, '### Presets', 'orgUnits.preset.apply'],
])('includes the required save step after applying a preset in %s', (_module, source, heading, apply) => {
  const section = source.slice(source.indexOf(heading)).split('\n## ')[0]!;
  const applyAt = section.indexOf(`{{ui:${apply}}}`);
  expect(applyAt).toBeGreaterThanOrEqual(0);
  expect(section.indexOf('{{ui:settings.draft.save}}', applyAt)).toBeGreaterThan(applyAt);
});
