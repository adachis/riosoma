import type { SignatureValue } from '@riosoma/contracts';
import { signatureText, type FormatContext } from '../grid/format';
import './fields.css';

/**
 * A signature as it was signed: the drawing, scaled to fit, or the typed name when nothing was
 * drawn.  Its accessible name says who signed and when.
 */
export function SignatureView({
  value,
  format,
  size = 'md',
}: {
  value: SignatureValue;
  format: FormatContext;
  size?: 'sm' | 'md';
}) {
  return (
    <span className="rio-signature" data-size={size} role="img" aria-label={signatureText(value, format)}>
      {value.drawing ? (
        <svg
          viewBox={`0 0 ${value.drawing.width} ${value.drawing.height}`}
          preserveAspectRatio="xMinYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <path d={value.drawing.path} />
        </svg>
      ) : (
        <span className="rio-signature__typed" aria-hidden="true">
          {value.name}
        </span>
      )}
    </span>
  );
}
