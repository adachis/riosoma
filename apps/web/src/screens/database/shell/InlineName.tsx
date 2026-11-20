import { LIMITS } from '@riosoma/contracts';
import { TextField } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';

export interface InlineNameProps {
  name: string;
  label: string;
  onSave(name: string): void;
  onCancel(restoreFocus?: boolean): void;
  pending?: boolean;
  preserveOnBlur?: boolean;
}

export function InlineName({ name, label, onSave, onCancel, pending, preserveOnBlur }: InlineNameProps) {
  const [value, setValue] = useState(name);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = container.current?.querySelector('input');
    input?.focus();
    input?.select();
  }, []);
  return (
    <div ref={container} className="rio-db-inline-name">
      <TextField
        aria-label={label}
        value={value}
        onChange={setValue}
        maxLength={LIMITS.nameLength}
        size="sm"
        isReadOnly={pending}
        onBlur={() => {
          if (!pending && !preserveOnBlur) onCancel(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (!pending && value.trim()) onSave(value.trim());
          }
        }}
      />
    </div>
  );
}
