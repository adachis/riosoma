import { createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/** Usage: node tools/sign-feed.mjs payload.json envelope.json key-id */
async function main() {
  const [input, output, keyId, ...extra] = process.argv.slice(2);
  if (!input || !output || !keyId || extra.length || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error();
  const material = process.env.RIOSOMA_FEED_SIGNING_KEY;
  if (!material) throw new Error();
  let key;
  if (material.includes('-----BEGIN PRIVATE KEY-----')) {
    key = createPrivateKey(material);
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(material)) throw new Error();
    const bytes = Buffer.from(material, 'base64url');
    // A raw Ed25519 seed is 32 bytes; a DER PKCS#8 value is accepted in the same encoding.
    const der = bytes.length === 32
      ? Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes])
      : bytes;
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error();
  const payload = await readFile(input, 'utf8');
  JSON.parse(payload);
  const signature = sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  await writeFile(output, `${JSON.stringify({ payload, signature, keyId })}\n`);
}

// Crypto errors can include their inputs. Never print an exception from loading a signing key.
main().catch(() => {
  process.exitCode = 1;
});
