import type { TrashWindow } from './trash.js';

export const TRASH_RETENTION_DAYS = 30;
export const DEFAULT_TRASH_WINDOW: TrashWindow = { days: TRASH_RETENTION_DAYS, legalHold: false };
