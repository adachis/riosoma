import { describe, expect, it } from 'vitest';
import { ANCHORS } from '../demos/anchors';
import { listModules, loadModule } from './loader';
import { sectionId } from './context';
import { settingsHelp } from './settings-help';
import { viewHelp } from './view-help';

describe('documentation coverage', () => {
  it('rejects retired anchors and missing sections, and reports undocumented anchors', async () => {
    const metadata = await listModules('en-US');
    const documented = new Set<string>();
    for (const meta of metadata) {
      for (const id of meta.anchors) {
        expect(Object.hasOwn(ANCHORS, id), `${meta.id}: ${id}`).toBe(true);
        documented.add(id);
      }
      const module = (await loadModule(meta.id, 'en-US'))!;
      const headings = new Set(
        [...module.body.matchAll(/^#{1,6} (.+)$/gm)].map((match) => sectionId(match[1]!)),
      );
      for (const mapping of meta.sections ?? []) {
        const [id, section] = mapping.split('=');
        expect(meta.anchors, `${meta.id}: ${mapping}`).toContain(id);
        expect(headings.has(section!), `${meta.id}: ${mapping}`).toBe(true);
      }
    }
    console.info(
      `Anchors without a help module: ${Object.keys(ANCHORS)
        .filter((id) => !documented.has(id))
        .join(', ')}`,
    );
  });

  it('opens every configured settings button at its declared module section', async () => {
    for (const topic of [...Object.values(settingsHelp), ...Object.values(viewHelp)]) {
      if (!topic) throw new Error('A configured help topic is missing');
      const module = (await loadModule(topic.id, 'en-US'))!;
      expect(module.meta.sections, `${topic.id}: ${topic.anchorId}`).toContain(
        `${topic.anchorId}=${topic.section}`,
      );
    }
  });
});
