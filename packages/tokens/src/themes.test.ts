import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeController, type ThemeManifest } from './themes';

const manifest = (id: string): ThemeManifest => ({
  id,
  name: id,
  css: 'theme.css',
  defaultScheme: 'base',
  schemes: [{ id: 'base', name: 'Base', appearance: 'light' }],
  modes: [],
  defaultMode: null,
  surfaces: [],
});

/** Just enough of a document for the theme switcher, so the test decides when each stylesheet loads. */
class FakeLink {
  rel = '';
  href = '';
  id = '';
  dataset: Record<string, string> = {};
  sheet: object | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(private readonly head: FakeHead) {}
  remove() {
    this.head.links = this.head.links.filter((l) => l !== this);
  }
  after(next: FakeLink) {
    this.head.links.splice(this.head.links.indexOf(this) + 1, 0, next);
  }
}

class FakeHead {
  links: FakeLink[] = [];
  append(link: FakeLink) {
    this.links.push(link);
  }
}

function fakeDocument() {
  const head = new FakeHead();
  const doc = {
    baseURI: 'http://localhost/',
    head,
    documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> },
    createElement: () => new FakeLink(head),
    getElementById: (id: string) => head.links.find((l) => l.id === id) ?? null,
    querySelectorAll: () => head.links.filter((l) => 'rioTheme' in l.dataset || l.id === 'rio-theme'),
  };
  return { doc: doc as unknown as Document, head, root: doc.documentElement };
}

afterEach(() => vi.unstubAllGlobals());

describe('ThemeController', () => {
  it('keeps the personal stylesheet when a forced manifest finishes after leaving the database', async () => {
    let releaseForced!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      releaseForced = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        const id = String(url).split('/').at(-2)!;
        return id === 'beta' ? delayed : new Response(JSON.stringify(manifest(id)));
      }),
    );
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    const { doc, head, root } = fakeDocument();
    const controller = new ThemeController('/themes/', doc);
    const personal = controller.apply({ theme: 'alpha' });
    await vi.waitFor(() => expect(head.links).toHaveLength(1));
    head.links[0]!.onload?.();
    await personal;

    const forced = controller.apply({ theme: 'beta' }, { remember: false });
    let forcedSettled = false;
    void forced.then(() => {
      forcedSettled = true;
    });
    await controller.apply({ theme: 'alpha' });
    releaseForced(new Response(JSON.stringify(manifest('beta'))));
    // If a stale request inserts a stylesheet, finish loading it before checking the page.
    await vi.waitFor(() => {
      head.links.find((link) => link.href.includes('/beta/'))?.onload?.();
      expect(forcedSettled).toBe(true);
    });
    await forced;
    expect(root.dataset.theme).toBe('alpha');
    expect(root.dataset.scheme).toBe('base');
    expect(head.links.map((link) => link.href)).toEqual([
      new URL('themes/alpha/theme.css', doc.baseURI).href,
    ]);
    expect(JSON.parse(stored.get('rio.theme')!)).toEqual({ theme: 'alpha', scheme: 'base' });
  });

  it('leaves exactly one theme stylesheet when changes overlap and finish out of order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => new Response(JSON.stringify(manifest(String(url).split('/').at(-2)!)))),
    );
    const { doc, head, root } = fakeDocument();
    const controller = new ThemeController('/themes/', doc);
    const first = controller.apply({ theme: 'alpha' });
    const second = controller.apply({ theme: 'beta' });
    await vi.waitFor(() => expect(head.links.some((l) => l.href.includes('/beta/'))).toBe(true));
    // The newer choice already removed the older link that was still loading.
    expect(head.links.map((l) => l.href)).toEqual(['http://localhost/themes/beta/theme.css']);
    for (const link of [...head.links].reverse()) link.onload?.();
    await Promise.all([first, second]);
    expect(head.links).toHaveLength(1);
    expect(head.links[0]!.id).toBe('rio-theme');
    expect(root.dataset.theme).toBe('beta');
  });

  it('replaces the stylesheet the page started with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest('gamma')))),
    );
    const { doc, head, root } = fakeDocument();
    const boot = new FakeLink(head);
    boot.id = 'rio-theme';
    boot.href = 'http://localhost/themes/nature/theme.css';
    head.append(boot);
    const applied = new ThemeController('/themes/', doc).apply({ theme: 'gamma' });
    await vi.waitFor(() => expect(head.links).toHaveLength(2));
    head.links[1]!.onload?.();
    await applied;
    expect(head.links.map((l) => l.href)).toEqual(['http://localhost/themes/gamma/theme.css']);
    expect(root.dataset.theme).toBe('gamma');
  });

  it('remembers a theme for the next visit only when asked to, so a forced one never sticks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => new Response(JSON.stringify(manifest(String(url).split('/').at(-2)!)))),
    );
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    const { doc, head } = fakeDocument();
    const controller = new ThemeController('/themes/', doc);
    const own = controller.apply({ theme: 'alpha' });
    await vi.waitFor(() => expect(head.links).toHaveLength(1));
    head.links[0]!.onload?.();
    await own;
    expect(JSON.parse(stored.get('rio.theme')!)).toEqual({ theme: 'alpha', scheme: 'base' });
    const forced = controller.apply({ theme: 'beta' }, { remember: false });
    await vi.waitFor(() => expect(head.links.some((l) => l.href.includes('/beta/'))).toBe(true));
    head.links.find((l) => l.href.includes('/beta/'))!.onload?.();
    await forced;
    expect(JSON.parse(stored.get('rio.theme')!)).toEqual({ theme: 'alpha', scheme: 'base' });
  });
});
