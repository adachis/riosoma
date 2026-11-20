import { msg, plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useSession } from '../../session';
import { searchSettings, settingHref, settingWords } from './registry';
import { activateSetting } from './useSettingTarget';
import { withSettingsReturn } from '../../shell/settings-return';

const SECTION_LABELS = {
  ai: msg({ id: 'settings.nav.ai', message: 'AI' }),
  preferences: msg({ id: 'settings.section.preferences', message: 'Preferences' }),
  account: msg({ id: 'settings.section.account', message: 'Account' }),
  security: msg({ id: 'settings.section.security', message: 'Security' }),
  connections: msg({ id: 'settings.section.connections', message: 'Connections' }),
  organization: msg({ id: 'settings.section.organization', message: 'Organization' }),
  server: msg({ id: 'settings.section.server', message: 'Server' }),
};

export function SettingsSearch() {
  const { t, i18n } = useLingui();
  const session = useSession();
  const navigate = useNavigate();
  const returnTo = useLocation({ select: (location) => location.search.returnTo });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();
  const results = useRef<HTMLDivElement>(null);
  const matches = searchSettings(i18n, session, query);
  const groups = [...new Set(matches.map((setting) => setting.section))];
  const rows = groups.flatMap((section) => matches.filter((setting) => setting.section === section));
  const index = Math.min(active, Math.max(0, rows.length - 1));
  const choose = (at: number) => {
    const setting = rows[at];
    if (!setting) return;
    setQuery('');
    const pathname = settingHref(setting);
    const href = withSettingsReturn(pathname, returnTo);
    void Promise.resolve(navigate({ to: href })).then(() => activateSetting(pathname));
  };
  const onKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('');
      return;
    }
    if (!query.trim()) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(index);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, index + step));
    setActive(Math.max(0, next));
    results.current
      ?.querySelector<HTMLElement>(`[data-result-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <div className="rio-settings-search">
      <label htmlFor={`${id}-input`}>{t({ id: 'settings.search.label', message: 'Search settings' })}</label>
      <input
        id={`${id}-input`}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={Boolean(query.trim() && rows.length)}
        aria-controls={`${id}-results`}
        aria-describedby={`${id}-help`}
        aria-activedescendant={query.trim() && rows.length ? `${id}-option-${index}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeys}
      />
      <p id={`${id}-help`} className="rio-settings-search__help">
        {t({
          id: 'settings.search.help',
          message:
            'Search labels and help. Use the arrow keys to choose a result, Enter to open it, and Escape to clear.',
        })}
      </p>
      <div role="status" aria-live="polite" className="rio-visually-hidden">
        {query.trim()
          ? t({
              id: 'settings.search.count',
              message: plural(rows.length, { one: '# setting found', other: '# settings found' }),
            })
          : ''}
      </div>
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label={t({ id: 'settings.search.results', message: 'Matching settings' })}
        ref={results}
        className="rio-settings-search__results"
        hidden={!query.trim() || !rows.length}
      >
        {groups.map((section) => (
          <div key={section} role="group" aria-labelledby={`${id}-section-${section}`}>
            <div id={`${id}-section-${section}`} className="rio-settings-search__section" aria-hidden="true">
              {i18n._(SECTION_LABELS[section as keyof typeof SECTION_LABELS])}
            </div>
            {rows.map((setting, at) => {
              if (setting.section !== section) return null;
              const words = settingWords(i18n, setting);
              return (
                <a
                  key={settingHref(setting)}
                  id={`${id}-option-${at}`}
                  href={withSettingsReturn(settingHref(setting), returnTo)}
                  role="option"
                  aria-selected={at === index}
                  tabIndex={-1}
                  data-result-index={at}
                  onMouseMove={() => setActive(at)}
                  onClick={(event) => {
                    if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
                      return;
                    event.preventDefault();
                    choose(at);
                  }}
                >
                  <strong>{words.label}</strong>
                  {setting.id !== 'overview' ? <span>{words.pageLabel}</span> : null}
                  {words.help ? <span>{words.help}</span> : null}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      {query.trim() && !rows.length ? (
        <p>{t({ id: 'settings.search.empty', message: 'No settings match your search.' })}</p>
      ) : null}
    </div>
  );
}
