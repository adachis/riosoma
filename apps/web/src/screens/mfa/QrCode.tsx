import { encode } from 'uqr';
import './mfa.css';

/** The four modules of light space scanners need around a code. */
const QUIET_ZONE = 4;

/**
 * A QR code drawn as one SVG path, a square per dark module.  The colors come from the theme,
 * arranged so the modules are always the darker of the two, which is what scanners expect.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: QUIET_ZONE });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      className="rio-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect className="rio-qr__light" width={size} height={size} />
      <path className="rio-qr__dark" d={path} />
    </svg>
  );
}
