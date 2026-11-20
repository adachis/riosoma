import { recoverImport } from '../asset-recovery';
import { RiosomaLogo } from '../brand/RiosomaLogo';
import { useEffect, useId, useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DOC_AREAS, type DocModuleMeta } from '@riosoma/contracts';
import { Banner, Button, Heading, Link, SearchField, Spinner, Text } from '@riosoma/ui';
import {
  faPlay,
  faXmark,
  faDownload,
  faArrowUpRightFromSquare,
  faWindowRestore,
  faList,
  faMagnifyingGlass,
  faArrowLeft,
  faArrowRight,
} from '@fortawesome/free-solid-svg-icons';
import { useDemos } from '../demos/DemoHost';
import { DocView } from './DocView';
import { listModules, loadModule, type DocModule } from './loader';
import './docs.css';
import { sectionId, type HelpTopic } from './context';
import { DocsWindow } from './DocsWindow';
import { HELP_REQUEST, type HelpRequest } from './help-request';

export interface DocsPanelProps {
  moduleId: string | null;
  section?: string;
  also?: HelpTopic[];
  inWindow?: boolean;
  onWindowChange?(open: boolean): void;
  hasUnits?: boolean;
  onOpen: (id: string, section?: string) => void;
  onClose: () => void;
}

const areas = {
  'data-sources': msg({ id: 'docs.area.data-sources', message: 'Data sources' }),
  'getting-started': msg({ id: 'docs.area.getting-started', message: 'Getting started' }),
  rio: msg({ id: 'docs.area.rio', message: 'Rio and AI' }),
  databases: msg({ id: 'docs.area.databases', message: 'Databases' }),
  appearance: msg({ id: 'docs.area.appearance', message: 'Appearance' }),
  personal: msg({ id: 'docs.area.personal', message: 'Personal' }),
  account: msg({ id: 'docs.area.account', message: 'Account' }),
  administration: msg({ id: 'docs.area.administration', message: 'Administration' }),
};

type Loaded = { metadata: DocModuleMeta[]; module: DocModule | null; modules: DocModule[] };

export function DocsPanel(props: DocsPanelProps) {
  const { i18n } = useLingui();
  const locale = i18n.locale || 'en-US';
  const selected = props.moduleId || null;
  const address = `${selected ?? ''}:${props.section ?? ''}`;
  const [navigation, setNavigation] = useState<{
    entries: Array<{ id: string | null; section?: string }>;
    cursor: number;
    observed: string;
  }>({ entries: [{ id: selected, section: props.section }], cursor: 0, observed: address });
  if (navigation.observed !== address) {
    const current = navigation.entries[navigation.cursor]!;
    const same = current.id === selected && current.section === props.section;
    const entries = same
      ? navigation.entries
      : [...navigation.entries.slice(0, navigation.cursor + 1), { id: selected, section: props.section }];
    setNavigation({ entries, cursor: same ? navigation.cursor : entries.length - 1, observed: address });
  }
  const go = (next: number) => {
    const topic = navigation.entries[next]!;
    setNavigation({ ...navigation, cursor: next });
    props.onOpen(topic.id ?? '', topic.section);
  };
  const contents = (
    <PanelContents
      key={`${locale}:${selected ?? ''}`}
      {...props}
      moduleId={selected}
      locale={locale}
      previous={navigation.cursor > 0 ? () => go(navigation.cursor - 1) : undefined}
      next={navigation.cursor < navigation.entries.length - 1 ? () => go(navigation.cursor + 1) : undefined}
    />
  );
  return props.inWindow ? <DocsWindow>{contents}</DocsWindow> : contents;
}

function PanelContents({
  moduleId,
  hasUnits = true,
  onOpen,
  onClose,
  locale,
  section,
  also = [],
  inWindow,
  onWindowChange,
  previous,
  next,
}: DocsPanelProps & { locale: string; previous?: () => void; next?: () => void }) {
  const { t, i18n } = useLingui();
  const titleId = useId();
  const heading = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [showIndex, setShowIndex] = useState(moduleId === null);
  const [sectionRequest, setSectionRequest] = useState(0);
  const [observedSection, setObservedSection] = useState(section);
  if (observedSection !== section) {
    setObservedSection(section);
    setShowIndex(moduleId === null);
  }
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const demos = useDemos();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const requested = (event: Event) => {
      const topic = (event as CustomEvent<HelpRequest>).detail;
      if (topic.id !== moduleId || !topic.section) return;
      setShowIndex(false);
      setSectionRequest((current) => current + 1);
    };
    document.addEventListener(HELP_REQUEST, requested);
    return () => document.removeEventListener(HELP_REQUEST, requested);
  }, [moduleId]);

  useEffect(() => {
    let active = true;
    Promise.all([listModules(locale), moduleId ? loadModule(moduleId, locale) : null])
      .then(([metadata, module]) => {
        return Promise.all(metadata.map((meta) => loadModule(meta.id, locale))).then((modules) => {
          if (active) setLoaded({ metadata, module, modules: modules.filter((entry) => entry !== null) });
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [moduleId, locale]);

  useEffect(() => {
    if (!loaded || showIndex) return;
    const target = section ? panel.current?.querySelector<HTMLElement>(`#doc-section-${section}`) : null;
    (target ?? heading.current)?.focus({ preventScroll: true });
    if (target && panel.current) {
      const chrome = panel.current.querySelector<HTMLElement>('.rio-docs-panel__chrome');
      panel.current.scrollTop +=
        target.getBoundingClientRect().top -
        panel.current.getBoundingClientRect().top -
        (chrome?.getBoundingClientRect().height ?? 0) -
        16;
    }
  }, [loaded, showIndex, section, sectionRequest]);

  const module = showIndex ? null : loaded?.module;
  const titles = new Map(loaded?.metadata.map((meta) => [meta.id, meta.title]));
  const search = query.trim().toLocaleLowerCase(locale);
  const matches =
    loaded?.metadata.filter(
      (meta) =>
        (hasUnits || meta.id !== 'org-units') &&
        `${meta.title} ${meta.summary} ${search ? (loaded.modules.find((entry) => entry.meta.id === meta.id)?.body ?? '') : ''}`
          .toLocaleLowerCase(locale)
          .includes(search),
    ) ?? [];
  const groupedAreas = [
    ...DOC_AREAS,
    ...new Set(matches.map((meta) => meta.area).filter((area) => !DOC_AREAS.some((known) => known === area))),
  ];
  const open = (id: string, section?: string) => {
    setShowIndex(false);
    onOpen(id, section);
  };

  async function exportPdf() {
    setExporting(true);
    setExportFailed(false);
    try {
      const pdf = await recoverImport(() => import('./pdf'));
      if (module) await pdf.exportModulePdf(module.meta.id, locale);
      else await pdf.exportAllPdf(locale);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <aside
      ref={panel}
      className="rio-docs-panel"
      data-help-content
      aria-label={t({ id: 'docs.title', message: 'Help' })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.target as Element).matches('input')) event.preventDefault();
      }}
    >
      <div className="rio-docs-panel__chrome">
        <header className="rio-docs-panel__header">
          <div ref={heading} tabIndex={-1} className="rio-docs-panel__title">
            <RiosomaLogo variant="wordmark" />
            <Heading id={titleId} level={2}>
              {module?.meta.title ?? t({ id: 'docs.title', message: 'Help' })}
            </Heading>
          </div>
          <Button
            variant="quiet"
            onPress={onClose}
            aria-label={t({ id: 'docs.close', message: 'Close help' })}
            icon={faXmark}
          />
        </header>
        <div
          className="rio-docs-panel__tools"
          role="toolbar"
          aria-label={t({ id: 'docs.navigation', message: 'Help navigation' })}
        >
          <Button
            variant="quiet"
            icon={faList}
            aria-label={t({ id: 'docs.allTopics', message: 'All topics' })}
            onPress={() => {
              setShowIndex(true);
              onOpen('');
            }}
          />
          <Button
            variant="quiet"
            icon={faMagnifyingGlass}
            aria-label={t({ id: 'docs.search', message: 'Search help' })}
            onPress={() => {
              setShowIndex(true);
              requestAnimationFrame(() => panel.current?.querySelector<HTMLInputElement>('input')?.focus());
            }}
          />
          <Button
            variant="quiet"
            icon={faArrowLeft}
            aria-label={t({ id: 'docs.back', message: 'Back' })}
            isDisabled={!previous}
            onPress={() => {
              setShowIndex(false);
              previous?.();
            }}
          />
          <Button
            variant="quiet"
            icon={faArrowRight}
            aria-label={t({ id: 'docs.forward', message: 'Forward' })}
            isDisabled={!next}
            onPress={() => {
              setShowIndex(false);
              next?.();
            }}
          />
          {onWindowChange && (
            <Button
              variant="quiet"
              icon={inWindow ? faWindowRestore : faArrowUpRightFromSquare}
              aria-label={
                inWindow
                  ? t({ id: 'docs.dock', message: 'Dock help panel' })
                  : t({ id: 'docs.openWindow', message: 'Open in a window' })
              }
              onPress={() => onWindowChange(!inWindow)}
            />
          )}
        </div>
      </div>
      {failed ? (
        <Banner tone="danger">
          <Trans id="docs.loadFailed">Help could not be loaded. Close help and try again.</Trans>
        </Banner>
      ) : !loaded ? (
        <Spinner label={t({ id: 'docs.loading', message: 'Loading help' })} />
      ) : showIndex ? (
        <>
          <SearchField
            autoFocus
            label={t({ id: 'docs.search', message: 'Search help' })}
            value={query}
            onChange={setQuery}
          />
          {matches.length === 0 && (
            <Text elementType="p" role="status">
              <Trans id="docs.noResults">No help topics match your search.</Trans>
            </Text>
          )}
          {groupedAreas.map((area) => {
            const entries = matches.filter((meta) => meta.area === area);
            if (!entries.length) return null;
            return (
              <section key={area} className="rio-docs-panel__area">
                <Heading level={3}>
                  {area in areas ? i18n._(areas[area as keyof typeof areas]) : i18n._(`docs.area.${area}`)}
                </Heading>
                <ul className="rio-docs-panel__modules">
                  {entries.map((meta) => (
                    <li key={meta.id}>
                      <Link onPress={() => open(meta.id)}>{meta.title}</Link>
                      <Text elementType="p" variant="muted">
                        {meta.summary}
                      </Text>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      ) : module ? (
        <>
          <Text elementType="p" variant="muted">
            {module.meta.summary}
          </Text>
          {module.meta.demo && demos ? (
            <Button
              className="rio-docs-panel__show-me"
              icon={faPlay}
              isDisabled={demos.running}
              onPress={() => demos.start(module.meta)}
              onHoverStart={() => {
                void demos.preload?.();
              }}
              onFocus={() => {
                void demos.preload?.();
              }}
            >
              <Trans id="demos.showMe">Show me</Trans>
            </Button>
          ) : null}
          <nav aria-label={t({ id: 'docs.contents', message: 'Table of contents' })}>
            <ul className="rio-docs-panel__modules">
              {[...module.body.matchAll(/^## (.+)$/gm)].map((match) => (
                <li key={match[1]}>
                  <Link onPress={() => open(module.meta.id, sectionId(match[1]!))}>{match[1]}</Link>
                </li>
              ))}
            </ul>
          </nav>
          <DocView body={module.body} titles={titles} onOpen={open} />
          {also.filter((topic) => topic.id !== module.meta.id).length > 0 && (
            <section className="rio-docs-panel__area">
              <Heading level={3}>
                <Trans id="docs.also">Also about this screen</Trans>
              </Heading>
              <ul className="rio-docs-panel__modules">
                {also
                  .filter((topic) => topic.id !== module.meta.id)
                  .map((topic) => (
                    <li key={topic.id}>
                      <Link onPress={() => open(topic.id, topic.section)}>
                        {titles.get(topic.id) ?? topic.id}
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          )}
          {module.meta.related.length > 0 && (
            <section className="rio-docs-panel__area">
              <Heading level={3}>
                <Trans id="docs.related">Related topics</Trans>
              </Heading>
              <ul className="rio-docs-panel__modules">
                {module.meta.related.map((id) => (
                  <li key={id}>
                    <Link onPress={() => open(id)}>{titles.get(id) ?? id}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <Banner tone="warning">
          <Trans id="docs.notFound">This help topic could not be found.</Trans>
        </Banner>
      )}
      {loaded && (showIndex || module) && (
        <Button
          isPending={exporting}
          onPress={() => void exportPdf()}
          aria-label={
            showIndex
              ? t({ id: 'docs.downloadAll', message: 'Download all help as PDF' })
              : t({ id: 'docs.download', message: 'Download PDF' })
          }
          icon={faDownload}
        />
      )}
      {exportFailed && (
        <Banner tone="danger">
          <Trans id="docs.exportFailed">The PDF could not be downloaded. Try again.</Trans>
        </Banner>
      )}
    </aside>
  );
}
