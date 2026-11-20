import type { FullConfig } from '@playwright/test';
import suiteSetup from '../global-setup';

/**
 * Starts the suite's own local stack for the seed to fill.  When `RIOSOMA_WEBSITE_BASE_URL` names
 * an instance that's already running, the seed fills that one instead and nothing is started.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const instance = process.env.RIOSOMA_WEBSITE_BASE_URL?.replace(/\/+$/, '');
  if (!instance) return suiteSetup(config);
  for (const project of config.projects) process.env[`RIOSOMA_E2E_BASE_URL_${project.name}`] = instance;
  return async () => undefined;
}
