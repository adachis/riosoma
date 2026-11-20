import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { SetupStage } from '@riosoma/contracts';
import { readStored, writeStored } from '../config.js';

/**
 * Where first-run setup stands, and the one-time token that guards it.  Until an owner exists,
 * whoever reaches the server first could claim it, so every setup call must carry the token the
 * server printed to its log.  The token disappears once setup is complete.
 */
export class SetupState {
  stage: SetupStage = 'database';
  private token: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly configDir: string,
    private readonly envToken: string | undefined,
  ) {}

  async refresh(pool: pg.Pool | null, appSchema: string): Promise<SetupStage> {
    if (!pool) {
      this.stage = 'database';
    } else {
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "${appSchema}".orgs) AS exists`,
      );
      this.stage = result.rows[0]?.exists ? 'ready' : 'owner';
    }
    if (this.stage === 'ready') this.clearToken();
    else this.ensureToken();
    return this.stage;
  }

  /** The token to print, or null once setup is complete. */
  get currentToken(): string | null {
    return this.stage === 'ready' ? null : this.token;
  }

  verify(candidate: string | undefined): boolean {
    if (this.stage === 'ready' || !this.token || !candidate) return false;
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  /** Runs setup changes one at a time, so two browsers can't both configure the server. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private ensureToken(): void {
    if (this.envToken) {
      this.token = this.envToken;
      return;
    }
    const stored = readStored(this.configDir).setupToken;
    if (stored) {
      this.token = stored;
      return;
    }
    this.token = randomBytes(18).toString('base64url');
    writeStored(this.configDir, { setupToken: this.token });
  }

  private clearToken(): void {
    this.token = null;
    if (readStored(this.configDir).setupToken) writeStored(this.configDir, { setupToken: undefined });
  }
}
