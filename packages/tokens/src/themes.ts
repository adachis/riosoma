/**
 * Theme switching, following the contract in themes/README.md: one stylesheet per theme, plus
 * `data-scheme`, `data-mode`, and `data-surface` attributes.  The new stylesheet loads before the
 * old one is removed, so the page never renders unstyled.
 */
export interface SchemeInfo {
  id: string;
  name: string;
  appearance: 'light' | 'dark';
}

export interface ThemeManifest {
  id: string;
  name: string;
  css: string;
  defaultScheme: string;
  schemes: SchemeInfo[];
  modes: string[];
  defaultMode: string | null;
  surfaces: string[];
}

export interface ThemeIndexEntry {
  id: string;
  name: string;
  css: string;
  manifest: string;
  defaultScheme: string;
  schemeCount: number;
  modes: string[];
}

export interface ThemeChoice {
  theme: string;
  scheme?: string | undefined;
  mode?: string | undefined;
}

export const DEFAULT_THEME: ThemeChoice = { theme: 'nature', scheme: 'grove' };

const LINK_ID = 'rio-theme';
const STORAGE_KEY = 'rio.theme';

export class ThemeController {
  private readonly manifests = new Map<string, Promise<ThemeManifest>>();
  private index: Promise<ThemeIndexEntry[]> | null = null;

  constructor(
    private readonly base = '/themes/',
    private readonly doc: Document = document,
  ) {}

  list(): Promise<ThemeIndexEntry[]> {
    this.index ??= this.getJson<{ themes: ThemeIndexEntry[] }>('index.json').then((r) => r.themes);
    return this.index;
  }

  manifest(themeId: string): Promise<ThemeManifest> {
    let m = this.manifests.get(themeId);
    if (!m) {
      m = this.getJson<ThemeManifest>(`${themeId}/theme.json`);
      m.catch(() => this.manifests.delete(themeId));
      this.manifests.set(themeId, m);
    }
    return m;
  }

  /**
   * Applies a theme to the whole page and returns what was actually applied after fallbacks.  The
   * browser remembers it for the next visit's first paint, unless `remember` is false, as it is for
   * a theme a database forces while it's open.
   */
  async apply(
    choice: ThemeChoice,
    options: { remember?: boolean } = {},
  ): Promise<Required<Pick<ThemeChoice, 'theme' | 'scheme'>> & { mode?: string }> {
    const generation = ++this.generation;
    const m = await this.manifest(choice.theme);
    const superseded = {
      theme: choice.theme,
      scheme: choice.scheme ?? m.defaultScheme,
      ...(choice.mode ? { mode: choice.mode } : {}),
    };
    // A delayed manifest must not replace the stylesheet for a newer choice.
    if (generation !== this.generation) return superseded;
    await this.swapStylesheet(new URL(`${choice.theme}/${m.css}`, this.baseUrl()).href);
    // Check again after loading so a superseded choice never updates attributes or storage.
    if (generation !== this.generation) return superseded;
    const root = this.doc.documentElement;
    root.dataset.theme = choice.theme;
    const scheme = m.schemes.some((s) => s.id === choice.scheme) ? choice.scheme! : m.defaultScheme;
    setScheme(scheme, root);
    const mode = m.modes.length
      ? choice.mode && m.modes.includes(choice.mode)
        ? choice.mode
        : (m.defaultMode ?? undefined)
      : undefined;
    setMode(mode, root);
    const appearance = m.schemes.find((s) => s.id === scheme)?.appearance ?? 'light';
    root.style.colorScheme = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : appearance;
    const applied = { theme: choice.theme, scheme, ...(mode ? { mode } : {}) };
    if (options.remember !== false) remember(applied);
    return applied;
  }

  private baseUrl(): string {
    return new URL(this.base, this.doc.baseURI).href;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl()));
    if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
    return (await res.json()) as T;
  }

  private pending: HTMLLinkElement | null = null;
  private settlePending: (() => void) | null = null;
  private generation = 0;

  private swapStylesheet(href: string): Promise<void> {
    // A newer choice supersedes a stylesheet that is still loading, so two overlapping changes
    // can never leave two themes on the page.  The superseded change settles at once rather than
    // waiting on a load that will never come.
    this.pending?.remove();
    this.pending = null;
    this.settlePending?.();
    this.settlePending = null;
    const current = this.doc.getElementById(LINK_ID) as HTMLLinkElement | null;
    if (current?.href === href) return Promise.resolve();
    const next = this.doc.createElement('link');
    next.rel = 'stylesheet';
    next.href = href;
    next.dataset.rioTheme = '';
    this.pending = next;
    return new Promise((resolve, reject) => {
      this.settlePending = resolve;
      const done = () => {
        if (this.pending !== next) return resolve();
        this.pending = null;
        this.settlePending = null;
        for (const link of this.doc.querySelectorAll<HTMLLinkElement>(
          'link[data-rio-theme], link#rio-theme',
        )) {
          if (link !== next) link.remove();
        }
        next.id = LINK_ID;
        resolve();
      };
      next.onload = done;
      // An @import inside the sheet failing (a font server while offline) still fires error, but
      // the theme applies; only a sheet that never loaded counts as a failure.
      next.onerror = () => {
        if (next.sheet) return done();
        next.remove();
        if (this.pending === next) {
          this.pending = null;
          this.settlePending = null;
        }
        reject(new Error(`Couldn't load ${href}`));
      };
      // Insert right after the current theme so the cascade order stays put.
      if (current) current.after(next);
      else this.doc.head.append(next);
    });
  }
}

export function setScheme(schemeId: string | undefined, el: HTMLElement): void {
  if (schemeId) el.dataset.scheme = schemeId;
  else delete el.dataset.scheme;
}

export function setMode(mode: string | undefined, el: HTMLElement): void {
  if (mode) el.dataset.mode = mode;
  else delete el.dataset.mode;
}

/** The last theme this browser used, so the next visit paints in it before anything loads. */
export function remembered(): ThemeChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ThemeChoice) : null;
  } catch {
    return null;
  }
}

function remember(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private browsing or storage turned off: the theme still applies, it just isn't remembered.
  }
}
