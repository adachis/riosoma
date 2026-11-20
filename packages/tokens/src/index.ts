export * from './themes';
export { contrastRatio, adjustForContrast, legibleOn, mix } from './legibility';

/** Fixed shell sizes in pixels, mirrored from base.css for layout math in code. */
export const LAYOUT = {
  headerHeight: 48,
  toolbarHeight: 40,
  footerHeight: 32,
  sidebarMin: 265,
  sidebarMax: 300,
  dockWidth: 380,
} as const;

/** Touch presses leave a little room for fingers to settle before starting a move. */
export const TOUCH_DRAG_ACTIVATION = { delay: 220, tolerance: 7 } as const;
