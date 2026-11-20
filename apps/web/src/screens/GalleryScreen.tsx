import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ThemeIndexEntry, ThemeManifest } from '@riosoma/tokens';
import { RIO_GALLERY } from '@riosoma/rio/gallery';
import { GALLERY as UI_GALLERY } from '@riosoma/ui/gallery';

const GALLERY = [...UI_GALLERY, ...RIO_GALLERY];
import { themes } from '../preferences';
import './GalleryScreen.css';

/**
 * Every shared component, every example, in any theme and color scheme.  The theme and scheme
 * live in the URL, so a link reproduces exactly what someone saw.
 */
export function GalleryScreen() {
  const { t } = useLingui();
  const search = useSearch({ from: '/app/gallery' });
  const navigate = useNavigate({ from: '/gallery' });
  const [index, setIndex] = useState<ThemeIndexEntry[]>([]);
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);

  useEffect(() => {
    void themes.list().then(setIndex);
  }, []);

  useEffect(() => {
    if (!search.theme) return;
    void themes.apply({ theme: search.theme, scheme: search.scheme }).then(async (applied) => {
      setManifest(await themes.manifest(applied.theme));
    });
  }, [search.theme, search.scheme]);

  return (
    <div className="rio-gallery">
      <div className="rio-gallery__controls">
        <label>
          <Trans id="gallery.theme">Theme</Trans>{' '}
          <select
            value={search.theme ?? ''}
            onChange={(e) => void navigate({ search: { theme: e.target.value } })}
            aria-label={t({ id: 'gallery.theme', message: 'Theme' })}
          >
            <option value="">{t({ id: 'gallery.currentTheme', message: 'Current theme' })}</option>
            {index.map((th) => (
              <option key={th.id} value={th.id}>
                {th.name}
              </option>
            ))}
          </select>
        </label>
        {manifest ? (
          <label>
            <Trans id="gallery.scheme">Color scheme</Trans>{' '}
            <select
              value={search.scheme ?? manifest.defaultScheme}
              onChange={(e) => void navigate({ search: { theme: search.theme, scheme: e.target.value } })}
            >
              {manifest.schemes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {GALLERY.map((entry) => (
        <section
          key={entry.id}
          className="rio-gallery__entry"
          id={entry.id}
          aria-labelledby={`${entry.id}-title`}
        >
          <h2 id={`${entry.id}-title`}>{entry.title}</h2>
          {entry.examples.map((example) => (
            <div key={example.id} className="rio-gallery__example" data-example={`${entry.id}.${example.id}`}>
              {example.render()}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
