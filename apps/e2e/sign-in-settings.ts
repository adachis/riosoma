import { isDeepStrictEqual } from 'node:util';
import { expect, test as baseTest } from './accessibility';
import { base } from './base';
import { ensureOwner, OWNER } from './helpers';

/** Restore sign-in settings even when a test times out and its browser has already closed. */
export const test = baseTest.extend<{ restoreSignInSettings: void }>({
  restoreSignInSettings: [
    async ({ request: api }, use) => {
      await ensureOwner();
      const signedIn = await api.post(`${base()}/api/auth/sign-in`, {
        data: { email: OWNER.email, password: OWNER.password },
      });
      expect(signedIn.ok(), await signedIn.text()).toBe(true);
      const session = await api.get(`${base()}/api/auth/session`);
      expect(session.ok(), await session.text()).toBe(true);
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const providers = async () => {
        const response = await api.get(`${base()}/api/admin/sso`);
        expect(response.ok(), await response.text()).toBe(true);
        return (await response.json()) as Array<{ id: string }>;
      };
      const original = (await providers()).map(({ id }) => id);
      const readPolicy = async (path: string) => {
        const response = await api.get(`${base()}${path}`);
        expect(response.ok(), await response.text()).toBe(true);
        const policy = await response.json();
        return path.endsWith('/unit-policy')
          ? { values: policy.own, overridable: policy.overridable }
          : policy;
      };
      const policies = await Promise.all(
        ['/api/admin/mfa/policy', '/api/admin/password-reset/policy', '/api/admin/unit-policy'].map(
          async (path) => {
            return { path, data: await readPolicy(path) };
          },
        ),
      );
      try {
        await use();
      } finally {
        for (const { id } of await providers()) {
          if (original.includes(id)) continue;
          const deleted = await api.delete(`${base()}/api/admin/sso/${encodeURIComponent(id)}`, {
            headers: { 'x-csrf-token': csrfToken },
          });
          expect(deleted.ok(), await deleted.text()).toBe(true);
        }
        expect((await providers()).map(({ id }) => id).sort()).toEqual(original.sort());
        for (const { path, data } of policies) {
          if (!isDeepStrictEqual(await readPolicy(path), data)) {
            const restored = await api.put(`${base()}${path}`, {
              headers: { 'x-csrf-token': csrfToken },
              data,
            });
            expect(restored.ok(), await restored.text()).toBe(true);
          }
          expect(await readPolicy(path)).toEqual(data);
        }
      }
    },
    { auto: true },
  ],
});
