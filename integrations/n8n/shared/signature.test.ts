import { describe, expect, it } from 'vitest';
import { checkSignature, sign } from './signature';

const body = '{"id":"dlv00000000000001","events":[]}';
const now = 1_760_538_600;

describe('checkSignature', () => {
  it('accepts a call signed with the secret', () => {
    const header = `t=${now},v1=${sign('rio_whsec_new', now, body)}`;
    expect(checkSignature(header, body, 'rio_whsec_new', now + 10)).toBe('valid');
    expect(checkSignature(header, Buffer.from(body), 'rio_whsec_new', now + 10)).toBe('valid');
  });

  it('accepts either signature while a secret is being replaced', () => {
    const header = `t=${now},v1=${sign('rio_whsec_new', now, body)},v1=${sign('rio_whsec_old', now, body)}`;
    expect(checkSignature(header, body, 'rio_whsec_old', now)).toBe('valid');
    expect(checkSignature(header, body, 'rio_whsec_new', now)).toBe('valid');
  });

  it('refuses a changed body, another secret, and a missing header', () => {
    const header = `t=${now},v1=${sign('rio_whsec_new', now, body)}`;
    expect(checkSignature(header, `${body} `, 'rio_whsec_new', now)).toBe('mismatch');
    expect(checkSignature(header, body, 'rio_whsec_other', now)).toBe('mismatch');
    expect(checkSignature(undefined, body, 'rio_whsec_new', now)).toBe('missing');
    expect(checkSignature(`v1=${sign('rio_whsec_new', now, body)}`, body, 'rio_whsec_new', now)).toBe(
      'missing',
    );
  });

  it('refuses a call signed more than five minutes away, so it cannot be replayed', () => {
    const header = `t=${now},v1=${sign('rio_whsec_new', now, body)}`;
    expect(checkSignature(header, body, 'rio_whsec_new', now + 301)).toBe('stale');
    expect(checkSignature(header, body, 'rio_whsec_new', now - 301)).toBe('stale');
    expect(checkSignature(header, body, 'rio_whsec_new', now + 299)).toBe('valid');
  });
});
