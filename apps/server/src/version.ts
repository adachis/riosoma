/** Set at build time for releases; development builds report the package version. */
import { configuredVersion } from './config.js';

export const VERSION = configuredVersion();
