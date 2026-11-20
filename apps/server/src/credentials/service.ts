import { randomBytes } from 'node:crypto';
import type { Queryable } from '@riosoma/db';
import { seal, unseal } from '../secrets.js';
import {
  associatedData,
  localKey,
  openEnvelope,
  parseEnvelope,
  rewrapEnvelope,
  sealEnvelope,
  unavailable,
  type KeyEncryptionKey,
  type SecretBinding,
} from './envelope.js';
import { vaultFor } from './adapters.js';
import type { CredentialSettings } from './settings.js';
import type { CredentialVault } from './vault.js';

export interface CredentialPolicy {
  profile: string;
  keyId: string;
}
export interface CredentialRepository {
  policy(orgId: string, db?: Queryable): Promise<CredentialPolicy>;
  key(orgId: string, id: string, db?: Queryable): Promise<KeyEncryptionKey>;
  replace(orgId: string, context: string, previous: string, next: string): Promise<void>;
  failed(orgId: string, profile: string): Promise<void>;
}

export const credentialBinding = (orgId: string, context: string): SecretBinding => ({
  orgId,
  owner: context,
  purpose: 'stored-credential',
});
interface Reference {
  profile: string;
  reference: string;
}
const services = new WeakMap<Buffer, CredentialService>();

export class CredentialService {
  private readonly vaults = new Map<string, CredentialVault>();
  private readonly cache = new Map<string, { until: number; value: string }>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly upkeep = new Set<Promise<void>>();

  constructor(
    private readonly instanceKey: Buffer,
    readonly settings: CredentialSettings,
    private readonly repository: CredentialRepository,
  ) {
    for (const profile of settings.profiles) this.vaults.set(profile.id, vaultFor(profile));
  }

  register(): () => void {
    services.set(this.instanceKey, this);
    return () => {
      services.delete(this.instanceKey);
      this.cache.clear();
    };
  }

  private maintain(work: Promise<void>): void {
    const pending = work
      .catch(() => {})
      .finally(() => {
        this.upkeep.delete(pending);
      });
    this.upkeep.add(pending);
  }

  async drain(): Promise<void> {
    await Promise.all(this.upkeep);
  }

  private reference(value: string, binding: SecretBinding): Reference {
    const ref = JSON.parse(
      unseal(this.instanceKey, value.slice(5), associatedData(binding).toString()),
    ) as Reference;
    if (typeof ref.profile !== 'string' || typeof ref.reference !== 'string' || !ref.reference)
      throw unavailable();
    return ref;
  }

  private vault(id: string): CredentialVault {
    const vault = this.vaults.get(id);
    if (!vault) throw unavailable();
    return vault;
  }

  async key(orgId: string, id: string, db?: Queryable): Promise<KeyEncryptionKey> {
    if (id === 'instance') return localKey(this.instanceKey);
    if (id.startsWith('external:')) {
      const profile = id.split(':')[1]!;
      const report = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch {
          this.maintain(this.repository.failed(orgId, profile));
          throw unavailable();
        }
      };
      const key = await report(async () => {
        const external = this.vault(profile).key?.(id);
        if (!external) throw unavailable();
        return external;
      });
      return {
        id,
        wrap: (value, aad) => report(() => key.wrap(value, aad)),
        unwrap: (value, aad) => report(() => key.unwrap(value, aad)),
      };
    }
    return this.repository.key(orgId, id, db);
  }

  async write(
    plaintext: string,
    orgId: string,
    context: string,
    policy?: CredentialPolicy,
    db?: Queryable,
  ): Promise<string> {
    const choice = policy ?? (await this.repository.policy(orgId, db));
    const binding = credentialBinding(orgId, context);
    try {
      const envelope = await sealEnvelope(await this.key(orgId, choice.keyId, db), plaintext, binding);
      return await this.store(envelope, choice.profile, binding);
    } catch {
      if (choice.profile !== 'database') this.maintain(this.repository.failed(orgId, choice.profile));
      throw unavailable();
    }
  }

  private async store(envelope: string, profile: string, binding: SecretBinding): Promise<string> {
    if (profile === 'database') return envelope;
    const vault = this.vault(profile);
    const reference = await vault.put(`rio-${randomBytes(24).toString('hex')}`, envelope);
    // Read back before committing a reference so an acknowledged but unusable write cannot replace a credential
    if ((await vault.get(reference)) !== envelope) throw unavailable();
    return `riov.${seal(this.instanceKey, JSON.stringify({ profile, reference }), associatedData(binding).toString())}`;
  }

  private async envelope(value: string, binding: SecretBinding): Promise<string> {
    if (!value.startsWith('riov.')) return value;
    const ref = this.reference(value, binding);
    const cacheKey = JSON.stringify([binding, value]);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;
    this.cache.delete(cacheKey);
    let pending = this.pending.get(cacheKey);
    if (!pending) {
      pending = this.vault(ref.profile)
        .get(ref.reference)
        .then((envelope) => {
          if (this.settings.cacheSeconds > 0) {
            if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(cacheKey, {
              value: envelope,
              until: Date.now() + this.settings.cacheSeconds * 1000,
            });
          }
          return envelope;
        })
        .catch(async () => {
          this.maintain(this.repository.failed(binding.orgId, ref.profile));
          throw unavailable();
        })
        .finally(() => {
          this.pending.delete(cacheKey);
        });
      this.pending.set(cacheKey, pending);
    }
    return pending;
  }

  async read(value: string, orgId: string, context: string, db?: Queryable): Promise<string> {
    try {
      const binding = credentialBinding(orgId, context);
      if (value.startsWith('rio1.')) {
        const plaintext = unseal(this.instanceKey, value, context);
        const next = await this.write(plaintext, orgId, context, undefined, db);
        // The caller may hold the row lock until it finishes using the credential
        this.maintain(this.repository.replace(orgId, context, value, next));
        return plaintext;
      }
      const envelope = await this.envelope(value, binding);
      return await openEnvelope(await this.key(orgId, parseEnvelope(envelope).keyId, db), envelope, binding);
    } catch {
      throw unavailable();
    }
  }

  async move(
    value: string,
    orgId: string,
    context: string,
    target: CredentialPolicy,
    db?: Queryable,
  ): Promise<string> {
    const binding = credentialBinding(orgId, context);
    if (value.startsWith('rio1.'))
      return this.write(unseal(this.instanceKey, value, context), orgId, context, target, db);
    const envelope = await this.envelope(value, binding);
    const previous = parseEnvelope(envelope);
    const next =
      previous.keyId === target.keyId
        ? envelope
        : await rewrapEnvelope(
            await this.key(orgId, previous.keyId, db),
            await this.key(orgId, target.keyId, db),
            envelope,
            binding,
          );
    const profile = value.startsWith('riov.') ? this.reference(value, binding).profile : 'database';
    return profile === target.profile && next === envelope
      ? value
      : this.store(next, target.profile, binding);
  }
}

export async function sealCredential(
  key: Buffer,
  plaintext: string,
  context: string,
  orgId: string,
  db?: Queryable,
): Promise<string> {
  const service = services.get(key);
  return service
    ? service.write(plaintext, orgId, context, undefined, db)
    : sealEnvelope(localKey(key), plaintext, credentialBinding(orgId, context));
}

export async function unsealCredential(
  key: Buffer,
  value: string,
  context: string,
  orgId: string,
  db?: Queryable,
): Promise<string> {
  const service = services.get(key);
  if (service) return service.read(value, orgId, context, db);
  if (value.startsWith('rio1.')) return unseal(key, value, context);
  return openEnvelope(localKey(key), value, credentialBinding(orgId, context));
}
