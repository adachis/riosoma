import { createContext } from 'react';

/** Explicit tooltips own their trigger so icon buttons do not open a second annotation. */
export const ButtonTooltipContext = createContext(false);
