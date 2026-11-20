import { ChoiceEditor } from './ChoiceEditor';
import type { EditorProps } from './types';

export function MultiSelectEditor(props: EditorProps) {
  const field = props.context.field;
  return field.type === 'multipleSelect' ? <ChoiceEditor {...props} field={field} multiple /> : null;
}
