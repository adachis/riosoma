import { useLingui } from '@lingui/react/macro';
import { cellValue } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { LineItemsEditor as RowsEditor } from '../../fields/LineItemsEditor';
import { EditorPopover } from './EditorPopover';
import type { EditorProps } from './types';

export function LineItemsEditor(props: EditorProps) {
  const { request, context } = props;
  const { t } = useLingui();
  if (context.field.type !== 'lineItems') return null;
  return (
    <EditorPopover {...props} onDismiss={() => request.cancel()}>
      <RowsEditor
        field={context.field}
        recordId={request.row.id}
        value={cellValue(request.row, context.field)}
        session={context.session}
        format={context.format}
      />
      <Button onPress={() => request.done('none')}>{t({ id: 'lineItems.done', message: 'Done' })}</Button>
    </EditorPopover>
  );
}
