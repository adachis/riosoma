import { HelpButton } from '../../../docs/HelpButton';
import { LazyBoundary, lazyFeature } from '../../../shell/lazy';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { faCheck, faPenToSquare, faPlus, faCode, faGlobe } from '@fortawesome/free-solid-svg-icons';
import {
  isSummaryBlock,
  roleAllows,
  type Block,
  type FilterBlockValue,
  type InterfaceMeta,
  type InterfacePage,
} from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, toast } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { undoAction, undoToast } from '../../../grid/view/actions';
import { serverMessage } from '../../../messages/useServerMessage';
import { firstFreeSpace } from '../dashboards/layout';
import { interfaceHref } from '../screen/routes';
import { availableViewName } from '../screen/view-name';
const BlockEditor = lazyFeature(() =>
  import('./BlockEditor').then((module) => ({ default: module.BlockEditor })),
);
import { CodeBody } from './CodeBody';
const PageJsonEditor = lazyFeature(() =>
  import('./PageJsonEditor').then((module) => ({ default: module.PageJsonEditor })),
);
import { BlockGrid } from './BlockGrid';
import { useInterfacePages } from './config';
import type { BlockContext } from './context';
import { useSummaryData } from './data';
import { KIND_LABELS } from './messages';
import { BLOCK_SIZES, MAX_BLOCKS, MAX_PAGES, newBlockId, newPageId, type BlockContent } from './model';
import { PageTabs } from './PageTabs';
import { RecordBody } from './RecordBlock';
import { RecordsBody } from './RecordsBlock';
import { HeroBody, MediaBody } from './PresentationBlocks';
import { ButtonBody, FilterBody, TextBody } from './SmallBlocks';
import { SitePublisher } from './SitePublisher';
import { SummaryBody } from './SummaryBlocks';
import '../dashboards/dashboards.css';
import { ResponsiveToolbar, type ResponsiveToolbarItem } from '../../../components/ResponsiveToolbar';
import './interfaces.css';

export interface InterfaceScreenProps {
  session: DatabaseSession;
  schema: SchemaState;
  interfaceId: string;
  /** The page in the link, or the first page when it's left out or gone */
  pageId?: string;
  /** Where a link to an interface that no longer exists goes instead */
  fallbackHref: string;
  /** How long record changes settle before blocks reload */
  refreshDelay?: number;
  /** The preview supplies page navigation and keeps links inside its dialog */
  preview?: boolean;
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"]')))
  );
}

/** Keeps the blocks on a page naming only blocks that are there: followed records blocks and filter targets. */
function reconcile(blocks: readonly Block[]): Block[] {
  const records = new Map(
    blocks.flatMap((block) => (block.kind === 'records' ? [[block.id, block.source.tableId] as const] : [])),
  );
  return blocks.map((block) => {
    if (block.kind === 'record' && block.recordsBlockId !== null && !records.has(block.recordsBlockId))
      return { ...block, recordsBlockId: null, fieldIds: [] };
    if (block.kind === 'filter') {
      const blockIds = block.blockIds.filter((id) => records.get(id) === block.tableId);
      if (blockIds.length !== block.blockIds.length) return { ...block, blockIds };
    }
    return block;
  });
}

/** A copy of a page with new IDs for it and its blocks, and the blocks still naming each other. */
function copyPage(page: InterfacePage, name: string): InterfacePage {
  const ids = new Map(page.blocks.map((block) => [block.id, newBlockId()]));
  const renamed = (id: string) => ids.get(id) ?? id;
  return {
    id: newPageId(),
    name,
    blocks: page.blocks.map((block): Block => {
      const id = renamed(block.id);
      if (block.kind === 'record')
        return { ...block, id, recordsBlockId: block.recordsBlockId ? renamed(block.recordsBlockId) : null };
      if (block.kind === 'filter') return { ...block, id, blockIds: block.blockIds.map(renamed) };
      return { ...block, id };
    }),
  };
}

/**
 * An interface: its name, its pages as tabs, and the page's blocks on a 12-column grid that
 * becomes one column on phones.  Everyone who can read the database uses it: picking records,
 * editing them where they may, filtering, and pressing buttons.  People who can change the schema
 * also get an edit mode that adds, configures, moves, and resizes blocks and manages the pages,
 * with keyboard ways to do all of it.  Every change saves through `interface.update`.
 */
export function InterfaceScreen(props: InterfaceScreenProps) {
  const value = props.schema.interfaceById.get(props.interfaceId);
  if (!value) return <MissingInterface fallbackHref={props.fallbackHref} />;
  return <InterfaceView key={value.id} {...props} value={value} />;
}

/** A link to an interface that no longer exists goes to the database's first table, and says so. */
function MissingInterface({ fallbackHref }: { fallbackHref: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  useEffect(() => {
    toast.show({
      tone: 'info',
      title: t({
        id: 'database.linkFixed',
        message: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    });
    void navigate({ to: fallbackHref, replace: true });
  }, [fallbackHref, navigate, t]);
  return <div className="rio-database-placeholder rio-database-placeholder--grid" />;
}

function InterfaceView({
  session,
  schema,
  value,
  pageId,
  refreshDelay,
  preview,
}: InterfaceScreenProps & { value: InterfaceMeta }) {
  const { t, i18n } = useLingui();
  const [publishing, setPublishing] = useState(false);
  const navigate = useNavigate();
  const headingId = useId();
  const search = useSearch({ strict: false });
  const canEdit = roleAllows(session.role(), 'editSchema');
  const canEditRecords = roleAllows(session.role(), 'editRecords');
  const { pages, change, save } = useInterfacePages(session, value);
  const [editingAsked, setEditing] = useState(false);
  const editorLink = typeof search.editor === 'string' ? search.editor : undefined;
  const jsonEditing = canEdit && editorLink === 'json';
  const editing = (editingAsked || Boolean(editorLink)) && canEdit;
  const [filters, setFilters] = useState<
    Readonly<Record<string, Readonly<Record<string, FilterBlockValue>>>>
  >({});
  const [picked, setPicked] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>({});
  const page = pages.find((item) => item.id === pageId) ?? pages[0];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = useMemo(
    () => ({
      locale: i18n.locale || 'en-US',
      timeZone,
      collaborators: schema.collaborators,
      linked: session.linked,
      attachments: session.attachments,
      fieldsById: schema.fieldById,
    }),
    [i18n.locale, timeZone, schema.collaborators, schema.fieldById, session],
  );
  const hrefFor = useCallback(
    (id?: string, selected?: { blockId: string; recordId: string }) =>
      interfaceHref(session.databaseId, value.id, id, selected),
    [session.databaseId, value.id],
  );

  // A link to a page that's gone opens the first one instead, and says so.
  const fixed = useRef('');
  useEffect(() => {
    if (!pageId || !page || page.id === pageId || fixed.current === pageId) return;
    fixed.current = pageId;
    toast.show({
      tone: 'info',
      title: t({
        id: 'database.linkFixed',
        message: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    });
    void navigate({ href: hrefFor(page.id), replace: true });
  }, [pageId, page, navigate, hrefFor, t]);

  const interfaceName = value.name;
  const databaseName = schema.database.name;
  useEffect(() => {
    const previous = document.title;
    document.title = i18n._({
      ...msg({ id: 'interfaces.pageTitle', message: '{name} – {database}' }),
      values: { name: interfaceName, database: databaseName },
    });
    return () => {
      document.title = previous;
    };
  }, [interfaceName, databaseName, i18n]);

  const pageKey = page?.id ?? '';
  const blocks = useMemo(() => page?.blocks ?? [], [page]);
  const summaryBlocks = useMemo(() => blocks.filter(isSummaryBlock), [blocks]);
  const summaries = useSummaryData(session, value.id, pageKey, summaryBlocks, refreshDelay);
  const linkBlock = typeof search.block === 'string' ? search.block : undefined;
  const linkRecord = typeof search.record === 'string' ? search.record : undefined;
  const selected = useMemo(
    () => ({
      ...(picked[pageKey] ?? {}),
      ...(linkBlock && linkRecord && pageId === pageKey ? { [linkBlock]: linkRecord } : {}),
    }),
    [picked, pageKey, linkBlock, linkRecord, pageId],
  );
  const onSelect = useCallback(
    (blockId: string, recordId: string, options?: { open?: boolean }) => {
      setPicked((current) => ({ ...current, [pageKey]: { ...selected, [blockId]: recordId } }));
      if (preview) return;
      void navigate({
        href: `${hrefFor(pageKey, { blockId, recordId })}${options?.open ? '&detail=record' : ''}`,
        replace: true,
      });
    },
    [pageKey, selected, navigate, hrefFor, preview],
  );
  const onMissing = useCallback(
    (blockId: string) => {
      setPicked((current) => {
        const { [blockId]: _gone, ...rest } = current[pageKey] ?? {};
        return { ...current, [pageKey]: rest };
      });
      toast.show({ tone: 'info', title: serverMessage(i18n, 'errors.notFound') });
      if (!preview && linkBlock === blockId) void navigate({ href: hrefFor(pageKey), replace: true });
    },
    [pageKey, linkBlock, navigate, hrefFor, i18n, preview],
  );
  const onFilter = useCallback(
    (blockId: string, next: FilterBlockValue | undefined) =>
      setFilters((current) => {
        const { [blockId]: _old, ...rest } = current[pageKey] ?? {};
        return { ...current, [pageKey]: next === undefined ? rest : { ...rest, [blockId]: next } };
      }),
    [pageKey],
  );

  const nameOf = (block: Block): string => {
    const title = block.title.trim();
    if (title) return title;
    switch (block.kind) {
      case 'records':
        return schema.tableById.get(block.source.tableId)?.name ?? i18n._(KIND_LABELS.records);
      case 'filter':
        return schema.fieldById.get(block.fieldId)?.name ?? i18n._(KIND_LABELS.filter);
      case 'button':
        return block.label.trim() || i18n._(KIND_LABELS.button);
      default:
        return i18n._(KIND_LABELS[block.kind]);
    }
  };
  const showsHeading = (block: Block) =>
    block.kind === 'records' || block.kind === 'record' || block.kind === 'number' || block.kind === 'chart'
      ? true
      : block.kind !== 'filter' && block.title.trim() !== '';

  const context: BlockContext | null = page
    ? {
        session,
        schema,
        format,
        interfaceId: value.id,
        page,
        canEditRecords,
        filters: filters[pageKey] ?? {},
        onFilter,
        selected,
        onSelect,
        onMissing,
        summaries: summaries.states,
        onRetry: summaries.retry,
        refreshDelay,
      }
    : null;

  const changePage = (next: (page: InterfacePage) => InterfacePage, options: { debounce?: boolean } = {}) => {
    if (!page) return;
    change(
      pages.map((item) => {
        if (item.id !== page.id) return item;
        const updated = next(item);
        return { ...updated, blocks: reconcile(updated.blocks) };
      }),
      options,
    );
  };
  const placeFor = (kind: Block['kind'], size = BLOCK_SIZES[kind]) =>
    firstFreeSpace(
      blocks.map((block) => block.place),
      size.w,
      size.h,
    );
  const closeEditor = () => {
    if (editorLink && page) void navigate({ href: hrefFor(page.id), replace: true });
  };
  const linkedBlock = page?.blocks.find((block) => block.id === editorLink);
  const activeEditor =
    canEdit && editorLink === 'new'
      ? { block: null }
      : canEdit && linkedBlock
        ? { block: linkedBlock }
        : null;
  const saveBlock = (content: BlockContent) => {
    const current = activeEditor?.block;
    closeEditor();
    if (!current) {
      changePage((item) => ({
        ...item,
        blocks: [...item.blocks, { ...content, id: newBlockId(), place: placeFor(content.kind) }],
      }));
      return;
    }
    const before = current.kind === 'records' ? current.source.tableId : null;
    const after = content.kind === 'records' ? content.source.tableId : null;
    changePage((item) => ({
      ...item,
      blocks: item.blocks.map((block): Block => {
        if (block.id === current.id) return { ...content, id: block.id, place: block.place };
        // Blocks following a records block that now reads another table start over with its fields.
        if (before !== after && block.kind === 'record' && block.recordsBlockId === current.id)
          return after ? { ...block, fieldIds: [] } : { ...block, recordsBlockId: null, fieldIds: [] };
        return block;
      }),
    }));
  };
  const addBlock = () => {
    save();
    setEditing(true);
    if (page) void navigate({ href: `${hrefFor(page.id)}?editor=new` });
  };
  const addPage = () => {
    const number = pages.length + 1;
    const created: InterfacePage = {
      id: newPageId(),
      name: t({ id: 'interfaces.page.new', message: `Page ${number}` }),
      blocks: [],
    };
    change([...pages, created]);
    void navigate({ href: hrefFor(created.id) });
  };
  const undoKeys = (event: KeyboardEvent<HTMLElement>) => {
    // Keys pressed in the block editor or a form arrive here through React, but belong to them.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    const key = event.key.toLowerCase();
    if (!(event.metaKey || event.ctrlKey) || event.altKey || editable(event.target)) return;
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    save();
    void undoAction(session, key === 'y' || event.shiftKey);
  };
  const full = blocks.length >= MAX_BLOCKS;
  const detailSource =
    search.detail === 'record' && blocks.find((block) => block.kind === 'records' && block.id === linkBlock);
  const closeRecord = () => {
    if (linkBlock && linkRecord)
      void navigate({ href: hrefFor(pageKey, { blockId: linkBlock, recordId: linkRecord }), replace: true });
  };

  return (
    <section className="rio-interface" aria-labelledby={headingId} onKeyDown={undoKeys}>
      <header className="rio-interface__header" data-anchor="interface.designer">
        <h2 id={headingId} className="rio-interface__title">
          {value.name}
        </h2>
        <HelpButton subject={value.name} moduleId="interfaces" section="editing-a-page" />
        <ResponsiveToolbar
          label={value.name}
          className="rio-interface__actions"
          items={[
            ...(roleAllows(session.role(), 'manage')
              ? [
                  {
                    id: 'publish',
                    variant: 'secondary' as const,
                    priority: 10,
                    icon: faGlobe,
                    label: t({ id: 'sites.publish', message: 'Publish site' }),
                    onAction: () => setPublishing(true),
                    render: (button) => (
                      <SitePublisher
                        value={value}
                        session={session}
                        schema={schema}
                        trigger={button}
                        isOpen={publishing}
                        onOpenChange={setPublishing}
                      />
                    ),
                  } satisfies ResponsiveToolbarItem,
                ]
              : []),
            ...(canEdit && editing && page
              ? [
                  {
                    id: 'json',
                    variant: 'secondary' as const,
                    priority: 20,
                    icon: faCode,
                    label: t({ id: 'interfaces.json.title', message: 'Edit page JSON' }),
                    onAction: () => {
                      save();
                      void navigate({ href: `${hrefFor(page.id)}?editor=json` });
                    },
                  },
                  {
                    id: 'add',
                    onPreload: BlockEditor.preload,
                    variant: 'secondary' as const,
                    priority: 80,
                    icon: faPlus,
                    disabled: full,
                    label: t({ id: 'interfaces.editor.add', message: 'Add a block' }),
                    onAction: addBlock,
                  },
                ]
              : []),
            ...(canEdit
              ? [
                  {
                    id: 'edit',
                    onPreload: BlockEditor.preload,
                    variant: editing ? ('primary' as const) : ('secondary' as const),
                    priority: 100,
                    icon: editing ? faCheck : faPenToSquare,
                    active: editing,
                    label: editing
                      ? t({ id: 'interfaces.done', message: 'Done' })
                      : t({ id: 'interfaces.edit', message: 'Edit interface' }),
                    onAction: () => {
                      save();
                      setEditing(!editing);
                    },
                  },
                ]
              : []),
          ]}
        />
      </header>
      {!preview ? (
        <PageTabs
          pages={pages}
          activePageId={page?.id ?? null}
          hrefFor={(id) => hrefFor(id)}
          onNavigate={(id) => {
            save();
            void navigate({ href: hrefFor(id) });
          }}
          editing={editing}
          canAdd={pages.length < MAX_PAGES}
          onAdd={addPage}
          onRename={(id, name) => change(pages.map((item) => (item.id === id ? { ...item, name } : item)))}
          onDuplicate={(id) => {
            const source = pages.find((item) => item.id === id);
            if (!source) return;
            const name = availableViewName(
              i18n,
              source.name,
              pages.map((item) => item.name),
              true,
            );
            const copy = copyPage(source, name);
            const index = pages.indexOf(source);
            change([...pages.slice(0, index + 1), copy, ...pages.slice(index + 1)]);
            void navigate({ href: hrefFor(copy.id) });
          }}
          onDelete={(id) => {
            const gone = pages.find((item) => item.id === id);
            const rest = pages.filter((item) => item.id !== id);
            if (!gone || !rest.length) return;
            if (page?.id === id) void navigate({ href: hrefFor(rest[0]!.id), replace: true });
            change(rest);
            const name = gone.name;
            undoToast(session, t({ id: 'interfaces.page.deleted', message: `Deleted ${name}` }));
          }}
          onMove={(id, toIndex) => {
            const moving = pages.find((item) => item.id === id);
            if (!moving) return;
            const rest = pages.filter((item) => item.id !== id);
            change([...rest.slice(0, toIndex), moving, ...rest.slice(toIndex)]);
          }}
        />
      ) : null}
      {!page ? (
        <div className="rio-interface__empty">
          <p>{t({ id: 'interfaces.noPages', message: 'This interface has no pages yet.' })}</p>
          {canEdit ? (
            <Button
              variant="primary"
              icon={faPlus}
              onPress={addPage}
              aria-label={t({ id: 'interfaces.page.add', message: 'Add a page' })}
            />
          ) : null}
        </div>
      ) : !blocks.length ? (
        <div className="rio-interface__empty">
          <p>
            {canEdit
              ? t({
                  id: 'interfaces.page.empty',
                  message:
                    'This page is empty.  Add a block to show records, numbers, charts, text, heroes, media, filters, buttons, or custom code.',
                })
              : t({ id: 'interfaces.page.emptyToRead', message: 'This page is empty.' })}
          </p>
          {canEdit ? (
            <Button
              variant="primary"
              icon={faPlus}
              onPress={addBlock}
              aria-label={t({ id: 'interfaces.editor.add', message: 'Add a block' })}
            />
          ) : null}
        </div>
      ) : context ? (
        <BlockGrid
          blocks={blocks}
          editing={editing}
          nameOf={nameOf}
          showsHeading={showsHeading}
          canAdd={!full}
          renderBody={(block) => {
            const name = nameOf(block);
            switch (block.kind) {
              case 'code':
                return <CodeBody code={block} name={name} context={context} preview={preview} />;
              case 'records':
                return (
                  <RecordsBody
                    block={
                      block.pageSize === undefined && (editing || preview)
                        ? { ...block, pageSize: 25 }
                        : block
                    }
                    name={name}
                    context={context}
                  />
                );
              case 'record':
                return (
                  <RecordBody
                    block={block}
                    context={context}
                    nameOf={(id) => {
                      const source = blocks.find((item) => item.id === id);
                      return source ? nameOf(source) : '';
                    }}
                  />
                );
              case 'number':
              case 'chart':
                return <SummaryBody block={block} name={name} context={context} />;
              case 'hero':
                return <HeroBody block={block} context={context} />;
              case 'media':
                return <MediaBody block={block} context={context} />;
              case 'text':
                return <TextBody block={block} />;
              case 'filter':
                return <FilterBody block={block} name={name} context={context} />;
              case 'button':
                return <ButtonBody block={block} context={context} />;
            }
          }}
          onEdit={(block) => {
            save();
            void navigate({ href: `${hrefFor(page.id)}?editor=${encodeURIComponent(block.id)}` });
          }}
          onDuplicate={(block) => {
            const size = { w: block.place.w, h: block.place.h };
            changePage((item) => ({
              ...item,
              blocks: [...item.blocks, { ...block, id: newBlockId(), place: placeFor(block.kind, size) }],
            }));
          }}
          onDelete={(block) => {
            const name = nameOf(block);
            changePage((item) => ({ ...item, blocks: item.blocks.filter((other) => other.id !== block.id) }));
            undoToast(session, t({ id: 'interfaces.block.deleted', message: `Deleted ${name}` }));
          }}
          onLayout={(next, options) =>
            changePage((item) => ({ ...item, blocks: [...next] }), { debounce: !options?.immediate })
          }
        />
      ) : null}
      {detailSource && linkBlock && linkRecord && context ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) closeRecord();
          }}
          size="lg"
        >
          <Dialog>
            <DialogTitle>{t({ id: 'interfaces.block.record', message: 'Record details' })}</DialogTitle>
            <DialogBody>
              <RecordBody
                block={{
                  id: 'codeRecord',
                  kind: 'record',
                  title: '',
                  place: { x: 0, y: 0, w: 6, h: 4 },
                  recordsBlockId: linkBlock,
                  fieldIds: [],
                }}
                context={context}
                nameOf={() => nameOf(detailSource)}
              />
            </DialogBody>
            <DialogFooter>
              <Button onPress={closeRecord}>
                {t({ id: 'interfaces.code.closeRecord', message: 'Close record' })}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      ) : null}
      {jsonEditing && page ? (
        <LazyBoundary size="dialog" onDismiss={closeEditor}>
          <PageJsonEditor
            key={page.id}
            session={session}
            interfaceId={value.id}
            page={page}
            pages={pages}
            onClose={closeEditor}
          />
        </LazyBoundary>
      ) : null}
      {activeEditor && page && context && canEdit ? (
        <LazyBoundary size="dialog" onDismiss={closeEditor}>
          <BlockEditor
            key={`${page.id}:${activeEditor.block?.id ?? 'new'}`}
            context={context}
            session={session}
            schema={schema}
            page={page}
            block={activeEditor.block}
            nameOf={nameOf}
            onSave={saveBlock}
            onCancel={closeEditor}
          />
        </LazyBoundary>
      ) : null}
    </section>
  );
}
