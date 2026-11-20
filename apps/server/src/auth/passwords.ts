import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { algorithm: 2, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 };
// A fixed hash with the same cost keeps missing accounts on the normal verification path.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$+lgkslLkstGqjw1Cr7kpaw$tuWa5WCgbiN6nHo2MG2mYEUQ2qUDkYsgIs86vbiTqbw';

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  // The native verifier compares the derived hash in constant time.
  const matches = await verify(passwordHash ?? DUMMY_HASH, password);
  return passwordHash !== null && matches;
}
