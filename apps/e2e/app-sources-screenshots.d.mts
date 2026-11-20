import type { Browser } from '@playwright/test';

export function captureAppSources(options?: { browser?: Browser; outputDirectory?: string }): Promise<number>;
