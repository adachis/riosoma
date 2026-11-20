import { cellValue, idsOf } from '@riosoma/contracts';
import { useEffect, useRef, useState } from 'react';
import { AttachmentPanel } from '../../files/AttachmentPanel';
import { EditorPopover } from './EditorPopover';
import type { EditorProps } from './types';

export function AttachmentEditor(props: EditorProps) {
  const { context, request } = props;
  const { field, session } = context;
  const [ids, setIds] = useState(() => idsOf(cellValue(request.row, field)));
  const ended = useRef(false);
  useEffect(
    () =>
      session?.subscribeRecords(field.tableId, (changed) => {
        if (!changed.has(request.row.id)) return;
        const row = session.cachedRecord(field.tableId, request.row.id);
        if (row) setIds(idsOf(cellValue(row, field)));
      }),
    [session, field, request.row.id],
  );
  return (
    <EditorPopover
      {...props}
      onDismiss={() => {
        if (!ended.current) {
          ended.current = true;
          request.done('none');
        }
      }}
    >
      <AttachmentPanel
        field={field}
        recordId={request.row.id}
        ids={ids}
        session={session}
        details={context.format.attachments}
        locale={context.format.locale}
        autoFocus
        onSourceNavigate={() => {
          if (!ended.current) {
            ended.current = true;
            request.done('none');
          }
        }}
        onChange={(next) => {
          context.apply(next);
          setIds(next);
        }}
      />
    </EditorPopover>
  );
}
