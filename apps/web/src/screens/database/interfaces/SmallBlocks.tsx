import { LazyBoundary } from '../../../shell/lazy';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import {
  filterControls,
  type ButtonBlock,
  type FieldMeta,
  type FilterBlock,
  type FilterBlockValue,
  type TextBlock,
} from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { Button, Dialog, ListBoxItem, Modal, SearchField, Select } from '@riosoma/ui';
import type { SchemaState } from '../../../data/types';
import { NoteText } from '../dashboards/NoteText';
import { MarkdownText } from './MarkdownText';
import { interfaceHref } from '../screen/routes';
import { VIEW_DEFINITIONS } from '../views/registry';
import { BlockUnavailable } from './BlockStatus';
import type { BlockContext } from './context';

/** Saved paragraphs retain the Markdown supported by dashboard notes. */
export function TextBody({ block }: { block: TextBlock }) {
  if (!block.text.trim()) return null;
  return (
    <div className={`rio-interface-text${block.style === 'lead' ? ' rio-interface-lead' : ''}`}>
      {block.style === 'paragraph' ? (
        <NoteText text={block.text} />
      ) : (
        <MarkdownText text={block.text} heading={block.style === 'heading'} />
      )}
    </div>
  );
}

const ALL = '__all__';
const CHECKED = '__checked__';
const UNCHECKED = '__unchecked__';

/** The options a choice filter offers: the field's choices, the people who can open the database, or a checkbox's two states. */
function choicesOf(field: FieldMeta, schema: SchemaState, checked: string, unchecked: string) {
  switch (field.type) {
    case 'singleSelect':
    case 'multipleSelect':
      return field.options.choices.map((choice) => ({ id: choice.id, name: choice.name }));
    case 'user':
    case 'createdBy':
    case 'lastModifiedBy':
      return [...schema.collaborators.values()].map((person) => ({ id: person.id, name: person.name }));
    case 'checkbox':
      return [
        { id: CHECKED, name: checked },
        { id: UNCHECKED, name: unchecked },
      ];
    default:
      return [];
  }
}

/** How long typing pauses before a search narrows the page, so each letter doesn't read again */
export const SEARCH_DELAY = 300;

function SearchFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(text: string): void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const apply = (next: string, now = false) => {
    setText(next);
    clearTimeout(timer.current);
    if (now) onChange(next.trim());
    else timer.current = setTimeout(() => onChange(next.trim()), SEARCH_DELAY);
  };
  return (
    <SearchField
      label={label}
      value={text}
      onChange={(next) => apply(next)}
      onSubmit={(next) => apply(next, true)}
      onClear={() => apply('', true)}
    />
  );
}

/**
 * A filter block: a choice or search box that narrows the page's records blocks for its table.
 * What someone picks stays on their screen and never changes the interface for anyone else.
 */
export function FilterBody({
  block,
  name,
  context,
}: {
  block: FilterBlock;
  name: string;
  context: BlockContext;
}) {
  const { t } = useLingui();
  const field = context.schema.fieldById.get(block.fieldId);
  if (!field || field.tableId !== block.tableId || !filterControls(field).includes(block.control))
    return <BlockUnavailable />;
  const value = context.filters[block.id];
  const choose = (next: FilterBlockValue | undefined) => context.onFilter(block.id, next);
  if (block.control === 'search')
    return (
      <div className="rio-interface-filter">
        <SearchFilter
          key={block.id}
          label={name}
          value={typeof value === 'string' ? value : ''}
          onChange={(text) => choose(text || undefined)}
        />
      </div>
    );
  const options = choicesOf(
    field,
    context.schema,
    t({ id: 'interfaces.filter.checked', message: 'Checked' }),
    t({ id: 'interfaces.filter.unchecked', message: 'Unchecked' }),
  );
  const selected =
    value === true ? CHECKED : value === false ? UNCHECKED : typeof value === 'string' ? value : ALL;
  return (
    <div className="rio-interface-filter">
      <Select
        label={name}
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key === CHECKED) choose(true);
          else if (key === UNCHECKED) choose(false);
          else if (typeof key === 'string' && key !== ALL) choose(key);
          else choose(undefined);
        }}
      >
        <ListBoxItem id={ALL}>{t({ id: 'interfaces.filter.all', message: 'All' })}</ListBoxItem>
        {options.map((option) => (
          <ListBoxItem key={option.id} id={option.id}>
            {option.name}
          </ListBoxItem>
        ))}
      </Select>
    </div>
  );
}

/**
 * A button block: opens a web address in a new tab, or a table's form in a dialog, where people
 * who can add records add one.
 */
export function ButtonBody({ block, context }: { block: ButtonBlock; context: BlockContext }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { action } = block;
  const label = block.label.trim() || t({ id: 'interfaces.button.open', message: 'Open' });
  if (action.kind === 'url')
    return (
      <div className="rio-interface-button">
        <a
          className="rio-button"
          data-variant="primary"
          data-size="md"
          href={action.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="rio-button__content">
            {label}
            <Icon icon={faUpRightFromSquare} />
            <span className="rio-interface-visually-hidden">
              {t({ id: 'interfaces.button.newTab', message: '(opens in a new tab)' })}
            </span>
          </span>
        </a>
      </div>
    );
  if (action.kind === 'page') {
    const page = context.schema.interfaces
      .find((item) => item.id === context.interfaceId)
      ?.pages.find((item) => item.id === action.pageId);
    return page ? (
      <div className="rio-interface-button">
        <a
          className="rio-button"
          data-variant="primary"
          data-size="md"
          href={interfaceHref(context.session.databaseId, context.interfaceId, page.id)}
        >
          {label}
        </a>
      </div>
    ) : (
      <BlockUnavailable />
    );
  }
  const table = context.schema.tableById.get(action.tableId);
  const view = context.schema.viewById.get(action.viewId);
  if (!table || view?.tableId !== table.id || view.type !== 'form') return <BlockUnavailable />;
  const Form = VIEW_DEFINITIONS.form.View;
  return (
    <div className="rio-interface-button">
      <Button variant="primary" isDisabled={!context.canEditRecords || !Form} onPress={() => setOpen(true)}>
        {label}
      </Button>
      {!context.canEditRecords ? (
        <p className="rio-interface-hint">
          {t({ id: 'interfaces.button.noAccess', message: 'You can’t add records to this table.' })}
        </p>
      ) : null}
      {open && Form ? (
        <Modal
          isOpen
          isDismissable
          size="lg"
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        >
          <Dialog aria-label={label}>
            <LazyBoundary>
              <Form
                session={context.session}
                table={table}
                view={view}
                fields={context.schema.fields.get(table.id) ?? []}
                format={context.format}
                canEdit={false}
                onConfig={() => undefined}
                onExpand={() => undefined}
              />
            </LazyBoundary>
          </Dialog>
        </Modal>
      ) : null}
    </div>
  );
}
