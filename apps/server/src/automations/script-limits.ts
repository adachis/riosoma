import { DEFAULT_SCRIPT_LIMITS } from '../config.js';
import type { ScriptLimits } from './script.js';

/** The limits a script runs under when the configuration sets none */
export function scriptLimits(): ScriptLimits {
  return { ...DEFAULT_SCRIPT_LIMITS };
}

export function ingestScriptLimits(): ScriptLimits {
  return {
    memoryBytes: 128 * 1024 * 1024,
    timeoutMs: 60_000,
    outputBytes: 4 * 1024 * 1024,
    logBytes: 0,
  };
}
