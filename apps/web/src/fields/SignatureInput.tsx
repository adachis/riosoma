import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { checkCellValue, type FieldMeta, type SignatureValue } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { signatureText, type FormatContext } from '../grid/format';
import { SignaturePad } from './SignaturePad';
import { SignatureView } from './SignatureView';
import './fields.css';

export interface SignatureInputProps {
  field: Extract<FieldMeta, { type: 'signature' }>;
  value: SignatureValue | null;
  format: FormatContext;
  autoFocus?: boolean;
  readOnly?: boolean;
  onChange: (value: SignatureValue | null) => void;
  /** Leaves the pad without signing, when something else holds it open */
  onCancel?: () => void;
}

/**
 * A signature field: the signature and who signed it, which can be removed or signed again but
 * never edited, or the pad when there is none yet.  The server records who signs and when.
 */
export function SignatureInput({
  field,
  value,
  format,
  autoFocus,
  readOnly,
  onChange,
  onCancel,
}: SignatureInputProps) {
  const { t } = useLingui();
  const [signing, setSigning] = useState(false);
  if (value && !signing)
    return (
      <div className="rio-signature-input">
        <SignatureView value={value} format={format} />
        <span className="rio-signature-input__caption">{signatureText(value, format)}</span>
        {!readOnly && (
          <div className="rio-field-input__actions">
            <Button autoFocus={autoFocus} onPress={() => setSigning(true)}>
              {t({ id: 'fields.signature.again', message: 'Sign again' })}
            </Button>
            <Button
              variant="quiet"
              onPress={() => onChange(null)}
              aria-label={t({ id: 'fields.signature.remove', message: 'Remove signature' })}
              icon={faXmark}
            />
          </div>
        )}
      </div>
    );
  if (readOnly) return null;
  return (
    <SignaturePad
      label={field.name}
      autoFocus={autoFocus}
      onCancel={value ? () => setSigning(false) : onCancel}
      onSign={(signature) => {
        const checked = checkCellValue(field, { ...signature, signedAt: new Date().toISOString() });
        if (!checked.ok) return;
        setSigning(false);
        onChange(checked.value as SignatureValue);
      }}
    />
  );
}
