import { ChoiceEditor } from './ChoiceEditor';
import type { EditorProps } from './types';

export function SelectEditor(props: EditorProps) {
  const field = props.context.field;
  return field.type === 'singleSelect' ? <ChoiceEditor {...props} field={field} multiple={false} /> : null;
}
