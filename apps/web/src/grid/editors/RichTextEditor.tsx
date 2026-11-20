import { useRef } from 'react';
import { cellValue } from '@riosoma/contracts';
import { TextCellInput, type TextCellHandle } from '../../fields/TextCellInput';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';

/** Text editors remain mounted until their save answers, preserving drafts on a conflict. */
export function RichTextEditor(props: EditorProps) {
  const { request, context } = props;
  const ended = useRef(false);
  const input = useRef<TextCellHandle>(null);
  const move = useRef<'down' | 'none'>('down');
  const field = context.field;
  const stored = cellValue(request.row, field);
  function finish(move: 'down' | 'none') {
    if (ended.current) return;
    ended.current = true;
    if (move === 'none') request.cancel();
    else request.done(move);
  }
  return (
    <EditorPopover
      {...props}
      onDismiss={() => {
        if (!input.current?.canClose()) return false;
        move.current = 'none';
        if (field.type === 'longText') {
          input.current.save();
          return false;
        } else finish('none');
      }}
      onEscape={() => {
        if (input.current?.canClose() && !input.current.closeLink()) finish('none');
      }}
    >
      <div className="rio-rich-text-cell">
        <TextCellInput
          ref={input}
          session={context.session}
          recordId={request.row.id}
          field={field}
          value={typeof stored === 'string' ? stored : null}
          autoFocus
          initialText={request.initialText}
          grid
          onChange={(next) => {
            applyValue(context, next);
          }}
          onDone={() => finish(move.current)}
          onCancel={() => {
            if (input.current?.canClose()) finish('none');
          }}
        />
      </div>
    </EditorPopover>
  );
}
