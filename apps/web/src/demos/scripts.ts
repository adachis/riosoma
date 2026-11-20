import { DemoScript } from '@riosoma/contracts';
import { recoverImport } from '../asset-recovery';

/**
 * Demo scripts, one beside each help module that has one (`docs/modules/<area>/<id>/demo.json`),
 * loaded when someone asks for them.
 */
export function createDemoLoader(sources: Record<string, () => Promise<unknown>>) {
  const byModule = new Map<string, { path: string; load: () => Promise<unknown> }>();
  for (const [path, load] of Object.entries(sources)) {
    const match = /\/([^/]+)\/([^/]+)\/demo\.json$/.exec(path);
    if (!match) throw new Error(`Invalid demo path: ${path}`);
    byModule.set(match[2]!, { path, load });
  }
  const cache = new Map<string, Promise<DemoScript>>();

  /** The module's demo, or null when it has none.  A script that doesn't parse throws. */
  async function loadDemo(moduleId: string): Promise<DemoScript | null> {
    const entry = byModule.get(moduleId);
    if (!entry) return null;
    let pending = cache.get(moduleId);
    if (!pending) {
      pending = recoverImport(entry.load)
        .then((source) => {
          const script = DemoScript.parse(source);
          if (script.id !== moduleId)
            throw new Error(`${entry.path}: The demo's id doesn't match its module`);
          return script;
        })
        .catch((error: unknown) => {
          cache.delete(moduleId);
          throw error;
        });
      cache.set(moduleId, pending);
    }
    return pending;
  }

  return { loadDemo, demoIds: () => [...byModule.keys()] };
}

const loader = createDemoLoader(
  import.meta.glob('../../../../docs/modules/**/demo.json', { import: 'default' }),
);
export const { loadDemo } = loader;
