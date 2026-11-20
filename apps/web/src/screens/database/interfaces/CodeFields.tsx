import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { InterfaceCode } from '@riosoma/contracts';
import { ScriptField } from '../automations/ScriptField';
import { CodeBody } from './CodeBody';
import type { BlockContext } from './context';

export function CodeFields({
  code,
  onChange,
  context,
}: {
  code: InterfaceCode;
  onChange(value: Partial<InterfaceCode>): void;
  context: BlockContext;
}) {
  const { t } = useLingui();
  const [preview, setPreview] = useState(code);
  const { html, css, javascript } = code;
  useEffect(() => {
    const timer = setTimeout(() => setPreview({ html, css, javascript }), 400);
    return () => clearTimeout(timer);
  }, [html, css, javascript]);
  return (
    <div className="rio-interface-code-editor">
      <ScriptField
        label={t({ id: 'interfaces.code.html', message: 'HTML' })}
        value={html}
        onChange={(value) => onChange({ html: value })}
        readOnly={false}
      />
      <ScriptField
        label={t({ id: 'interfaces.code.css', message: 'CSS' })}
        value={css}
        onChange={(value) => onChange({ css: value })}
        readOnly={false}
      />
      <ScriptField
        label={t({ id: 'interfaces.code.javascript', message: 'JavaScript' })}
        value={javascript}
        onChange={(value) => onChange({ javascript: value })}
        readOnly={false}
      />
      <p>
        {t({
          id: 'interfaces.code.bridgeHelp',
          message:
            'Use rio.records(blockId), rio.selected(blockId), rio.open(blockId, recordId), or rio.change(blockId, recordId, values).  Preview can read records.  Opening and changing records are available after saving.',
        })}
      </p>
      <p>
        {t({
          id: 'interfaces.code.sourceLimit',
          message: 'Each source can contain up to 50,000 characters.',
        })}
      </p>
      <div className="rio-interface-code-preview">
        <CodeBody
          code={preview}
          context={context}
          name={t({ id: 'interfaces.code.preview', message: 'Live preview' })}
          preview
        />
      </div>
    </div>
  );
}
