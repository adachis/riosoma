import { useLingui } from '@lingui/react/macro';
import { EditorContent, useEditor } from '@tiptap/react';
import { cx } from '@riosoma/ui';
import { richTextExtensions } from './extensions';
import { editorDoc, markdownToDoc } from './markdown';
import './richText.css';

/**
 * A rich text value, formatted and read-only.  It renders through the editor itself, which builds
 * every element from the document rather than from markup, so nothing in a value can become HTML:
 * tags and entities show as the characters they are, and only web and mail links become links.
 */
export function RichTextView({ value, className }: { value: string; className?: string }) {
  const { t } = useLingui();
  const editor = useEditor(
    {
      editable: false,
      injectCSS: false,
      extensions: richTextExtensions({
        checkboxLabel: (text) =>
          text || t({ id: 'fields.richText.checklistItem', message: 'Checklist item' }),
      }),
      content: editorDoc(markdownToDoc(value)),
      // Shown, not edited, so it reads as its paragraphs and lists rather than as a text box.
      editorProps: { attributes: { role: 'presentation', class: 'rio-rich-text__content' } },
    },
    [value],
  );
  return <EditorContent editor={editor} className={cx('rio-rich-text-view', className)} />;
}
