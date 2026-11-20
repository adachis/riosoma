import type { UpdateRunState } from './updates.js';

export const FINISHED_RUN_STATES: readonly UpdateRunState[] = ['succeeded', 'rolled_back', 'failed'];
