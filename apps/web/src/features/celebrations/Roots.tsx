import type { CSSProperties } from 'react';
import './celebrations.css';

/** A taproot and its branches, spreading from the top of the palette toward its edges */
const ROOTS = [
  'M200 0 C198 40 206 70 196 110 C188 150 204 190 198 240',
  'M198 60 C170 80 140 84 104 118 C80 140 60 150 20 160',
  'M202 80 C236 96 262 104 300 136 C326 158 350 164 392 170',
  'M104 118 C96 96 70 86 40 80',
  'M300 136 C312 112 340 100 380 96',
  'M194 130 C170 150 150 176 132 214 C124 230 116 236 100 240',
  'M200 150 C224 170 244 196 262 240',
  'M150 176 C130 180 100 196 72 210',
  'M244 196 C270 200 300 214 330 236',
];

/** Roots spreading behind the palette's list: drawn only, never in the way of a click. */
export function Roots() {
  return (
    <svg
      className="rio-palette-roots"
      viewBox="0 0 400 240"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-testid="palette-roots"
    >
      {ROOTS.map((path, index) => (
        <path
          key={path}
          d={path}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
          style={{ '--rio-root': index } as CSSProperties}
        />
      ))}
    </svg>
  );
}
