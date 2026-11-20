import { trustedHTML } from '../../../security/trusted-types';
import { sparklineSvg, type SparklinePaint } from './sparklines';
import './sparklines.css';

export function SparklineChart({ paint }: { paint: SparklinePaint }) {
  return (
    <span
      className="rio-sparkline"
      role="img"
      aria-label={paint.label}
      title={paint.label}
      dangerouslySetInnerHTML={{ __html: trustedHTML(sparklineSvg(paint)) }}
    />
  );
}
