import { LineItemsEditor } from './LineItemsEditor';
import { I18nProvider } from '@lingui/react';
import { RouterContextProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import { i18n } from '../../i18n';
import { AttachmentEditor } from './AttachmentEditor';
import { RatingEditor } from './RatingEditor';
import { UserEditor } from './UserEditor';
import { LinkEditor } from './LinkEditor';
import { DateEditor } from './DateEditor';
import { MultiSelectEditor } from './MultiSelectEditor';
import { SelectEditor } from './SelectEditor';
import {
  MoreFieldEditor,
  DateRangeEditor,
  JsonEditor,
  LocationEditor,
  SignatureEditor,
} from './CompoundEditors';
import { RichTextEditor } from './RichTextEditor';
import type { EditorContext, EditorProps } from './types';
import './editors.css';

/** Mounts a DOM-requested editor with the app's catalog and the viewer's locale. */
const COMPOUND = {
  dateRange: DateRangeEditor,
  json: JsonEditor,
  location: LocationEditor,
  signature: SignatureEditor,
} as const;

export function mountEditor(request: EditorProps['request'], context: EditorContext): () => void {
  const type = context.field.type;
  const Editor =
    type === 'lineItems'
      ? LineItemsEditor
      : type === 'barcode' || type === 'time' || type === 'multiCurrency'
        ? MoreFieldEditor
        : type === 'dateRange' || type === 'json' || type === 'location' || type === 'signature'
          ? COMPOUND[type]
          : context.field.type === 'attachment'
            ? AttachmentEditor
            : context.field.type === 'rating'
              ? RatingEditor
              : context.field.type === 'user'
                ? UserEditor
                : context.field.type === 'link'
                  ? LinkEditor
                  : context.field.type === 'date'
                    ? DateEditor
                    : context.field.type === 'singleSelect'
                      ? SelectEditor
                      : context.field.type === 'multipleSelect'
                        ? MultiSelectEditor
                        : context.field.type === 'longText'
                          ? RichTextEditor
                          : null;
  if (Editor === null) return () => {};
  const container = request.anchor.ownerDocument.createElement('div');
  container.className = 'rio-cell-editor-mount';
  // The grid clips and recycles its cells. Keep the overlay outside it, with the cell's theme.
  const document = request.anchor.ownerDocument;
  const theme = document.defaultView?.getComputedStyle(request.anchor);
  if (theme) {
    for (let index = 0; index < theme.length; index++) {
      const property = theme.item(index);
      if (property.startsWith('--rio-'))
        container.style.setProperty(property, theme.getPropertyValue(property));
    }
  }
  document.body.append(container);
  const root = createRoot(container);
  const editor = <Editor request={request} context={context} portalContainer={container} />;
  root.render(
    <I18nProvider i18n={i18n}>
      <LocaleProvider locale={context.format.locale}>
        {context.router ? (
          <RouterContextProvider router={context.router}>{editor}</RouterContextProvider>
        ) : (
          editor
        )}
      </LocaleProvider>
    </I18nProvider>,
  );
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
    container.remove();
  };
}
