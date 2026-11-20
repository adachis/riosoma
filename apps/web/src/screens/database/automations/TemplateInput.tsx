import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Button, Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from '@riosoma/ui';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { BODY_PREFIX, splitTemplate, tokenText } from './tokens';

export interface TokenChoice {
  token: string;
  label: string;
}

export interface TokenGroup {
  id: string;
  title: string;
  choices: readonly TokenChoice[];
}

export interface ChipText {
  label: string;
  /** Points at something that no longer exists */
  missing: boolean;
  /** Where the value comes from, shown on hover */
  source?: string;
}

/** What a step's text can hold, and how each token reads. */
export interface TokenCatalog {
  groups: readonly TokenGroup[];
  /** Values that belong to no record, such as the current time */
  extras: readonly TokenChoice[];
  /** Offers a value from the webhook's JSON, whose path the person types */
  body: boolean;
  describe(token: string): ChipText;
}

export interface TemplateInputProps {
  label: string;
  value: string;
  onChange(value: string): void;
  catalog: TokenCatalog;
  multiline?: boolean;
  readOnly?: boolean;
  /** For code, such as a JSON body */
  monospace?: boolean;
  /** Puts the caret in the field once it appears */
  autoFocus?: boolean;
}

const ZERO_WIDTH = '\u200b';
const BODY_KEY = '#body';

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.token !== undefined;
}

function isFiller(node: Node | null | undefined): node is Text {
  return node instanceof Text && node.data.replaceAll(ZERO_WIDTH, '') === '';
}

function label(chip: HTMLElement, text: ChipText): void {
  if (chip.textContent !== text.label) chip.textContent = text.label;
  chip.toggleAttribute('data-missing', text.missing);
  if (text.source) chip.title = text.source;
  else chip.removeAttribute('title');
}

function chipFor(token: string, text: ChipText): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'rio-automation-template__chip';
  chip.contentEditable = 'false';
  chip.dataset.token = token;
  label(chip, text);
  return chip;
}

/** A caret can't rest after a chip that ends a line in every browser, so each one gets text after it. */
function textAfter(chip: HTMLElement): Text {
  const next = chip.nextSibling;
  if (next instanceof Text) return next;
  const filler = document.createTextNode(ZERO_WIDTH);
  chip.after(filler);
  return filler;
}

function draw(root: HTMLElement, template: string, describe: TokenCatalog['describe']): void {
  const nodes: Node[] = [];
  for (const segment of splitTemplate(template)) {
    if (segment.kind === 'token') {
      nodes.push(chipFor(segment.token, describe(segment.token)));
      continue;
    }
    segment.text.split('\n').forEach((line, index) => {
      if (index) nodes.push(document.createElement('br'));
      if (line) nodes.push(document.createTextNode(line));
    });
  }
  // A line break that ends the text only shows with another after it.
  if (template.endsWith('\n')) nodes.push(document.createElement('br'));
  root.replaceChildren(...nodes);
  for (const chip of root.querySelectorAll<HTMLElement>('[data-token]')) textAfter(chip);
}

function serialize(root: HTMLElement, multiline: boolean): string {
  let text = '';
  // The last line break only makes an empty last line show, so it isn't part of the text.
  let last = root.lastChild;
  while (isFiller(last)) last = last.previousSibling;
  const visit = (node: Node) => {
    if (node instanceof Text) text += node.data;
    else if (isChip(node)) text += tokenText(node.dataset.token!);
    else if (node instanceof HTMLBRElement) {
      if (node !== last) text += '\n';
    } else if (node instanceof HTMLElement) {
      if ((node.tagName === 'DIV' || node.tagName === 'P') && text && !text.endsWith('\n')) text += '\n';
      node.childNodes.forEach(visit);
    }
  };
  root.childNodes.forEach(visit);
  text = text.replaceAll(ZERO_WIDTH, '').replaceAll('\u00a0', ' ');
  return multiline ? text : text.replaceAll('\n', ' ');
}

function selectionIn(root: HTMLElement): Range | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null;
}

function endOf(root: HTMLElement): Range {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function placeCaret(root: HTMLElement, node: Node, offset: number): void {
  const range = root.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertNodes(range: Range, nodes: readonly Node[]): void {
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  range.insertNode(fragment);
}

/** Where the caret goes after a line break, adding the break that shows an empty last line. */
function afterBreak(root: HTMLElement, br: HTMLBRElement): [Node, number] {
  let next = br.nextSibling;
  while (isFiller(next)) next = next.nextSibling;
  if (!next) br.after(document.createElement('br'));
  return [root, [...root.childNodes].indexOf(br) + 1];
}

/** Puts a line break at the caret. */
function breakLine(root: HTMLElement): void {
  const range = selectionIn(root) ?? endOf(root);
  const br = document.createElement('br');
  insertNodes(range, [br]);
  const [node, offset] = afterBreak(root, br);
  placeCaret(root, node, offset);
}

/** Text with line breaks as the field shows them, and where the caret goes after it. */
function textNodes(root: HTMLElement, text: string, multiline: boolean): [Node[], () => [Node, number]] {
  const nodes: Node[] = [];
  const lines = multiline ? text.split('\n') : [text.replaceAll(/\s*\n\s*/g, ' ')];
  lines.forEach((line, index) => {
    if (index) nodes.push(document.createElement('br'));
    if (line) nodes.push(document.createTextNode(line));
  });
  const last = nodes.at(-1);
  return [
    nodes,
    () =>
      last instanceof HTMLBRElement
        ? afterBreak(root, last)
        : last instanceof Text
          ? [last, last.data.length]
          : [root, 0],
  ];
}

/** The chip right before or after a collapsed caret, looking past filler text. */
function chipBeside(range: Range, backward: boolean): HTMLElement | null {
  if (!range.collapsed) return null;
  const { startContainer: node, startOffset: offset } = range;
  let sibling: Node | null;
  if (node instanceof Text) {
    const beside = backward ? node.data.slice(0, offset) : node.data.slice(offset);
    if (beside.replaceAll(ZERO_WIDTH, '') !== '') return null;
    sibling = backward ? node.previousSibling : node.nextSibling;
  } else sibling = node.childNodes[backward ? offset - 1 : offset] ?? null;
  while (isFiller(sibling)) sibling = backward ? sibling.previousSibling : sibling.nextSibling;
  return isChip(sibling) ? sibling : null;
}

/**
 * A text field whose `{{…}}` tokens show as chips named after what they stand for.  The "+" button
 * beside it inserts a value where the caret was.  The field keeps its own text while the person
 * types, and redraws only when the value changes from outside.
 */
export function TemplateInput({
  label: labelText,
  value,
  onChange,
  catalog,
  multiline = false,
  readOnly = false,
  monospace = false,
  autoFocus = false,
}: TemplateInputProps) {
  const { t } = useLingui();
  const id = useId();
  const editor = useRef<HTMLDivElement>(null);
  /** The template the field shows right now */
  const shown = useRef<string | null>(null);
  /** The caret while the picker has focus */
  const caret = useRef<Range | null>(null);
  /** Counts the edits and presses in the field, so a frame that comes late can tell it's stale */
  const touched = useRef(0);
  const latest = useRef({ multiline, onChange });
  const [focusAtStart] = useState(autoFocus);
  const insertLabel = t({ id: 'automations.token.insert', message: 'Insert a value' });

  useLayoutEffect(() => {
    latest.current = { multiline, onChange };
    const root = editor.current;
    if (!root) return;
    if (shown.current !== value) {
      draw(root, value, catalog.describe);
      shown.current = value;
      caret.current = null;
    } else
      for (const chip of root.querySelectorAll<HTMLElement>('[data-token]'))
        label(chip, catalog.describe(chip.dataset.token!));
  });

  useLayoutEffect(() => {
    const root = editor.current;
    if (focusAtStart && root) requestAnimationFrame(() => root.focus());
  }, [focusAtStart]);

  function emit(): void {
    const root = editor.current;
    if (!root) return;
    touched.current++;
    const next = serialize(root, latest.current.multiline);
    shown.current = next;
    latest.current.onChange(next);
  }

  // Browsers also send line breaks and formatting as input events, as on-screen keyboards do.
  useLayoutEffect(() => {
    const root = editor.current;
    if (!root) return;
    const listener = (event: InputEvent) => {
      if (event.inputType.startsWith('format')) event.preventDefault();
      else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        if (!latest.current.multiline) return;
        breakLine(root);
        touched.current++;
        const next = serialize(root, true);
        shown.current = next;
        latest.current.onChange(next);
      }
    };
    root.addEventListener('beforeinput', listener);
    return () => root.removeEventListener('beforeinput', listener);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const root = event.currentTarget;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (multiline && !readOnly) {
        breakLine(root);
        emit();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      return;
    }
    if (readOnly || (event.key !== 'Backspace' && event.key !== 'Delete')) return;
    const range = selectionIn(root);
    const backward = event.key === 'Backspace';
    const chip = range && chipBeside(range, backward);
    if (!chip) return;
    event.preventDefault();
    const before = chip.previousSibling;
    const after = chip.nextSibling;
    if (isFiller(after)) after.remove();
    chip.remove();
    if (before instanceof Text) placeCaret(root, before, before.data.length);
    else placeCaret(root, root, before ? [...root.childNodes].indexOf(before) + 1 : 0);
    emit();
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>): void {
    event.preventDefault();
    const root = event.currentTarget;
    const text = event.clipboardData.getData('text/plain');
    if (readOnly || !text) return;
    const range = selectionIn(root) ?? endOf(root);
    const [nodes, end] = textNodes(root, text, multiline);
    insertNodes(range, nodes);
    const [node, offset] = end();
    placeCaret(root, node, offset);
    emit();
  }

  // Copying keeps the tokens, so pasting into another field brings the values along.
  function onCopy(event: ClipboardEvent<HTMLDivElement>, cut: boolean): void {
    const root = event.currentTarget;
    const range = selectionIn(root);
    if (!range || range.collapsed) return;
    event.preventDefault();
    const holder = document.createElement('div');
    holder.append(range.cloneContents());
    event.clipboardData.setData('text/plain', serialize(holder, multiline));
    if (cut && !readOnly) {
      range.deleteContents();
      emit();
    }
  }

  function onBlur(): void {
    const root = editor.current;
    if (!root) return;
    caret.current = selectionIn(root)?.cloneRange() ?? caret.current;
    // Tokens typed by hand become chips once the person moves on.
    const typed = [...root.childNodes].some(
      (node) => node instanceof Text && splitTemplate(node.data).some((segment) => segment.kind === 'token'),
    );
    if (typed && shown.current !== null) {
      draw(root, shown.current, catalog.describe);
      caret.current = null;
    }
  }

  function insert(key: string): void {
    const root = editor.current;
    if (!root) return;
    const saved = caret.current;
    const range =
      selectionIn(root) ?? (saved && root.contains(saved.startContainer) ? saved : null) ?? endOf(root);
    let target: [Node, number];
    if (key === BODY_KEY) {
      // The person types the path between the dot and the closing braces.
      const text = document.createTextNode(tokenText(BODY_PREFIX));
      insertNodes(range, [text]);
      target = [text, 2 + BODY_PREFIX.length];
    } else {
      const chip = chipFor(key, catalog.describe(key));
      insertNodes(range, [chip]);
      const after = textAfter(chip);
      target = [after, isFiller(after) ? after.data.length : 0];
    }
    placeCaret(root, ...target);
    caret.current = selectionIn(root)?.cloneRange() ?? null;
    emit();
    // The menu hands focus back to its button as it closes, so the field takes it after that.  A
    // busy browser can draw that frame late, after the person has already clicked or typed in the
    // field, and then the caret stays where they put it.
    const seen = touched.current;
    requestAnimationFrame(() => {
      if (touched.current !== seen) return;
      root.focus();
      if (root.contains(target[0])) placeCaret(root, ...target);
    });
  }

  return (
    <div className="rio-automation-template" data-multiline={multiline || undefined}>
      <span
        id={`${id}-label`}
        className="rio-automation-template__label"
        onClick={() => editor.current?.focus()}
      >
        {labelText}
      </span>
      <div className="rio-automation-template__row">
        <div
          ref={editor}
          role="textbox"
          aria-labelledby={`${id}-label`}
          aria-multiline={multiline || undefined}
          aria-readonly={readOnly || undefined}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          tabIndex={0}
          className="rio-automation-template__input"
          data-monospace={monospace || undefined}
          onInput={emit}
          onKeyDown={onKeyDown}
          onPointerDown={() => {
            touched.current++;
          }}
          onPaste={onPaste}
          onCopy={(event) => onCopy(event, false)}
          onCut={(event) => onCopy(event, true)}
          onDrop={(event) => event.preventDefault()}
          onBlur={onBlur}
        />
        {readOnly ? null : (
          <MenuTrigger>
            <Button
              className="rio-automation-template__insert"
              variant="quiet"
              size="sm"
              icon={faPlus}
              aria-label={insertLabel}
              aria-describedby={`${id}-label`}
            />
            <Menu aria-label={insertLabel} onAction={(key) => insert(String(key))}>
              {catalog.groups.map((group) => (
                <MenuSection key={group.id} title={group.title} aria-label={group.title}>
                  {group.choices.map((choice) => (
                    <MenuItem key={choice.token} id={choice.token}>
                      {choice.label}
                    </MenuItem>
                  ))}
                </MenuSection>
              ))}
              {catalog.groups.length ? <MenuSeparator /> : null}
              {catalog.extras.map((choice) => (
                <MenuItem key={choice.token} id={choice.token}>
                  {choice.label}
                </MenuItem>
              ))}
              {catalog.body ? (
                <MenuItem id={BODY_KEY}>
                  {t({ id: 'automations.token.body', message: 'A value from the webhook’s JSON' })}
                </MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        )}
      </div>
    </div>
  );
}

/**
 * A template field for a value kept in another shape, such as a list of addresses.  It keeps the
 * person's own text while they type, and shows a new value only when one arrives from outside.
 */
export function ParsedTemplateInput<T>({
  value,
  format,
  parse,
  same,
  onChange,
  ...props
}: Omit<TemplateInputProps, 'value' | 'onChange'> & {
  value: T;
  format(value: T): string;
  parse(text: string): T;
  same(a: T, b: T): boolean;
  onChange(value: T): void;
}) {
  const [text, setText] = useState(() => format(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (!same(parse(text), value)) setText(format(value));
  }
  return (
    <TemplateInput
      {...props}
      value={text}
      onChange={(next) => {
        setText(next);
        onChange(parse(next));
      }}
    />
  );
}
