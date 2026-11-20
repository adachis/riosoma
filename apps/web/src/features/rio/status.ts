import type { RioStatus } from '@riosoma/contracts';
import { api } from '../../api';
import { isDemoSession } from '../../demo';

const unavailable: RioStatus = {
  enabled: false,
  tiers: [],
  autonomy: 'ask',
  paused: false,
  diagnose: false,
  routines: false,
  routineRunLimitUsd: 0,
};

/** Availability and effective personal limits, shared by everything that asks Rio. */
export const rioStatusQuery = {
  queryKey: ['rio', 'status'],
  queryFn: async () => (isDemoSession() ? unavailable : api<RioStatus>('/api/rio/status')),
};
