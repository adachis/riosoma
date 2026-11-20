import { describe, expect, it } from 'vitest';
import { callOut, isPublicAddress, OutboundError } from './outbound.js';

describe('webhook addresses', () => {
  it('count only the public internet as public', () => {
    for (const address of [
      '93.184.215.14',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '2a00:1450:4001:82a::200e',
    ])
      expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '169.254.170.2',
      // A metadata address in the shared range, written as IPv4 inside IPv6.
      '::ffff:6464:64c8',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd00:ec2::254',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      // The unspecified address written as IPv4 inside IPv6, which a machine delivers to itself.
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '0:0:0:0:0:ffff:0:0',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:0001::1',
      '::10.0.0.1',
      'not an address',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
  });

  it('refuse calls that aren’t web addresses, or that smuggle in headers', async () => {
    const options = { resolve: async () => [], allowPrivate: true };
    const fails = async (request: Parameters<typeof callOut>[0]) => {
      const error = await callOut(request, options).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OutboundError);
      return error as OutboundError;
    };
    const base = { method: 'POST' as const, headers: {}, body: null };
    expect(await fails({ ...base, url: 'not a url' })).toMatchObject({
      messageKey: 'automations.step.failed',
      detail: 'url',
    });
    expect(await fails({ ...base, url: 'file:///etc/passwd' })).toMatchObject({ detail: 'url' });
    expect(
      await fails({ ...base, url: 'http://example.test/', headers: { 'x-name': 'a\r\nx-other: b' } }),
    ).toMatchObject({ detail: 'header' });
    expect(await fails({ ...base, url: 'http://nowhere.example.test/' })).toMatchObject({
      detail: 'resolve',
    });
    const blocked = await callOut(
      { ...base, url: 'http://inside.example.test/' },
      { resolve: async () => [{ address: '192.168.0.10', family: 4 }], allowPrivate: false },
    ).catch((caught: unknown) => caught);
    expect(blocked).toMatchObject({ messageKey: 'automations.webhook.blocked' });
  });
});
