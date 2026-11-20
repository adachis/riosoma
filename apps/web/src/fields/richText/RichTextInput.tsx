import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import { EditorContent, useEditor, type Content } from '@tiptap/react';
import { LIMITS } from '@riosoma/contracts';
import { Button, Link, TextField } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { isAppleDevice } from '../../shortcuts/registry';
import { richTextExtensions } from './extensions';
import { linkFromInput } from './links';
import { docToMarkdown, editorDoc, markdownToDoc, safeLinkHref } from './markdown';
import { RichTextToolbar } from './RichTextToolbar';
import './richText.css';

export interface RichTextHandle {
  /** The current draft, including a save the server rejected. */
  getValue(): string | null;
  isDirty(): boolean;
  /** Saves what changed.  False when the text can't be saved, and the reason shows under it. */
  save(): boolean;
  /** Closes the link bar.  False when it wasn't open. */
  closeLink(): boolean;
}

export interface RichTextInputProps {
  /** The stored Markdown, or null */
  value: string | null;
  labelId?: string;
  label?: string;
  autoFocus?: boolean;
  /** Text typed to start editing, which replaces the value, as typing into a grid cell does */
  initialText?: string | null;
  /** Saves when the focus leaves.  Off, it saves only through the handle or Ctrl+Enter. */
  saveOnBlur?: boolean;
  /** The Markdown to store, called only when it changed.  Null when the text is empty. */
  onChange: (value: string | null) => void;
  /** With `saveOnBlur` off: Ctrl+Enter saved, whether anything changed or not */
  onSaved?: () => void;
  ref?: Ref<RichTextHandle>;
}

function typedContent(text: string): Content {
  const content = text
    .split('\n')
    .flatMap((part, index) => [
      ...(index > 0 ? [{ type: 'hardBreak' }] : []),
      ...(part ? [{ type: 'text', text: part }] : []),
    ]);
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

/** What a stored value reads as once written back, so comparing two values ignores spelling. */
function settled(value: string | null): string {
  return docToMarkdown(markdownToDoc(value ?? ''));
}

/**
 * A long text field's rich text editor: a toolbar of formats over the text.  It stores Markdown,
 * and saves only when the words or their formats changed, so opening a value and leaving it never
 * rewrites it.
 */
export function RichTextInput({
  value,
  labelId,
  label,
  autoFocus = false,
  initialText = null,
  saveOnBlur = true,
  onChange,
  onSaved,
  ref,
}: RichTextInputProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const errorId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  /** While the link bar is open: the address being typed, and the link's address before */
  const [link, setLink] = useState<{ draft: string; existing: string | null } | null>(null);
  const [linkError, setLinkError] = useState('');
  const [initial] = useState(() => settled(value));
  const baseline = useRef(initial);
  const [setup] = useState(() => ({
    extensions: richTextExtensions({
      checkboxLabel: (text) => text || t({ id: 'fields.richText.checklistItem', message: 'Checklist item' }),
    }),
    content: initialText === null ? editorDoc(markdownToDoc(initial)) : typedContent(initialText),
  }));
  const editorProps = useMemo(
    () => ({
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        ...(labelId ? { 'aria-labelledby': labelId } : label ? { 'aria-label': label } : {}),
        'aria-describedby': errorId,
        ...(error ? { 'aria-invalid': 'true' } : {}),
        class: 'rio-rich-text__content',
        spellcheck: 'true',
      },
    }),
    [labelId, label, errorId, error],
  );
  const editor = useEditor({
    ...setup,
    editorProps,
    injectCSS: false,
    autofocus: autoFocus ? 'end' : false,
  });

  function save(): boolean {
    const markdown = docToMarkdown(editor.getJSON());
    if (markdown.length > LIMITS.longTextLength) {
      setError(message('data.value.tooLong'));
      return false;
    }
    setError('');
    if (markdown !== baseline.current) {
      baseline.current = markdown;
      onChange(markdown === '' ? null : markdown);
    }
    return true;
  }

  function closeLink(): boolean {
    if (link === null) return false;
    setLink(null);
    setLinkError('');
    editor.commands.focus();
    return true;
  }

  function openLink() {
    const href: unknown = editor.getAttributes('link').href;
    const existing = typeof href === 'string' ? href : null;
    setLink({ draft: existing ?? '', existing });
    setLinkError('');
  }

  function applyLink() {
    if (link === null) return;
    const href = linkFromInput(link.draft);
    if (href === null) {
      setLinkError(
        t({
          id: 'fields.richText.link.invalid',
          message: 'Enter a web address, such as https://example.com, or an email address.',
        }),
      );
      return;
    }
    if (editor.state.selection.empty && !editor.isActive('link'))
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: link.draft.trim(), marks: [{ type: 'link', attrs: { href } }] })
        .run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLink(null);
  }

  function removeLink() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLink(null);
  }

  useImperativeHandle(ref, () => ({
    save,
    closeLink,
    getValue: () => docToMarkdown(editor.getJSON()) || null,
    isDirty: () => docToMarkdown(editor.getJSON()) !== baseline.current,
  }));

  // A new value from elsewhere, such as undo or another person's edit, replaces the text.  The
  // value this editor just saved reads the same, so it leaves the text and the caret alone.
  useEffect(() => {
    const next = settled(value);
    if (next === baseline.current) return;
    baseline.current = next;
    editor.commands.setContent(editorDoc(markdownToDoc(next)), { emitUpdate: false });
    setError('');
  }, [editor, value]);

  const openable = link?.existing ? safeLinkHref(link.existing) : null;
  return (
    <div
      ref={root}
      className="rio-rich-text"
      onBlur={(event) => {
        if (
          !saveOnBlur ||
          (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))
        )
          return;
        save();
      }}
      onKeyDownCapture={(event) => {
        // Ctrl+Enter, Cmd+Enter on a Mac, saves.  It's caught on the way in, before the editor
        // would take it for a line break.
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.altKey || event.shiftKey) return;
        if (!(isAppleDevice() ? event.metaKey : event.ctrlKey)) return;
        // In the link bar it adds the link, as Enter does there.
        if (event.target instanceof Element && event.target.closest('.rio-rich-text__link')) return;
        event.preventDefault();
        event.stopPropagation();
        if (save() && !saveOnBlur) onSaved?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || !saveOnBlur) return;
        // Escape puts back the saved text, and only leaves the card when nothing changed.
        const saved = baseline.current;
        if (docToMarkdown(editor.getJSON()) === saved) return;
        event.preventDefault();
        event.stopPropagation();
        editor.commands.setContent(editorDoc(markdownToDoc(saved)), { emitUpdate: false });
        setError('');
      }}
    >
      <div className="rio-rich-text__frame" data-invalid={error ? '' : undefined}>
        <RichTextToolbar
          editor={editor}
          linking={link !== null}
          onLink={() => {
            if (!closeLink()) openLink();
          }}
        />
        {link !== null && (
          <div className="rio-rich-text__link">
            <TextField
              label={t({ id: 'fields.richText.link.address', message: 'Link address' })}
              size="sm"
              value={link.draft}
              autoFocus
              inputMode="url"
              isInvalid={linkError !== ''}
              validationBehavior="aria"
              errorMessage={linkError}
              onChange={(draft) => {
                setLink({ ...link, draft });
                setLinkError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  closeLink();
                } else event.continuePropagation();
              }}
            />
            <div className="rio-rich-text__link-actions">
              <Button size="sm" variant="primary" onPress={applyLink}>
                {t({ id: 'fields.richText.link.apply', message: 'Apply' })}
              </Button>
              {link.existing !== null && (
                <Button
                  size="sm"
                  onPress={removeLink}
                  aria-label={t({ id: 'fields.richText.link.remove', message: 'Remove link' })}
                  icon={faXmark}
                />
              )}
              <Button size="sm" variant="quiet" onPress={closeLink}>
                {t({ id: 'fields.richText.link.cancel', message: 'Cancel' })}
              </Button>
              {openable && (
                <Link href={openable} external>
                  {t({ id: 'fields.richText.link.open', message: 'Open link' })}
                </Link>
              )}
            </div>
          </div>
        )}
        <EditorContent editor={editor} className="rio-rich-text__body" />
      </div>
      <div id={errorId} className="rio-field-input__error" aria-live="polite">
        {error}
      </div>
    </div>
  );
}
