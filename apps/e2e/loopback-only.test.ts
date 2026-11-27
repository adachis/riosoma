import { expect, it } from 'vitest';
import { checkLoopbackOnly } from './loopback-only';

const ci = { CI: 'true' };

it('does nothing outside CI', () => {
  expect(checkLoopbackOnly({ env: {}, platform: 'linux', interfaces: ['lo', 'eth0'] })).toEqual({});
  expect(checkLoopbackOnly({ env: { CI: '' }, platform: 'linux', interfaces: ['eth0'] })).toEqual({});
});

it('does nothing on a platform other than Linux', () => {
  expect(checkLoopbackOnly({ env: ci, platform: 'darwin', interfaces: ['lo0', 'en0'] })).toEqual({});
  expect(checkLoopbackOnly({ env: ci, platform: 'win32', interfaces: ['Ethernet'] })).toEqual({});
});

it('requires the wrapper when CI runs on Linux without it', () => {
  expect(() => checkLoopbackOnly({ env: ci, platform: 'linux', interfaces: ['lo'] })).toThrow(
    /tools\/ci\/loopback-only\.sh/,
  );
  expect(() => checkLoopbackOnly({ env: ci, platform: 'linux', interfaces: ['lo'] })).toThrow(
    /ERR_NETWORK_CHANGED/,
  );
});

it('accepts a namespace that shows only loopback and its online interface', () => {
  expect(
    checkLoopbackOnly({
      env: { ...ci, RIOSOMA_LOOPBACK_ONLY: '1' },
      platform: 'linux',
      interfaces: ['lo', 'rio-online'],
    }),
  ).toEqual({});
});

it('rejects a namespace without its online interface, where browsers would report themselves offline', () => {
  expect(() =>
    checkLoopbackOnly({
      env: { ...ci, RIOSOMA_LOOPBACK_ONLY: '1' },
      platform: 'linux',
      interfaces: ['lo'],
    }),
  ).toThrow(/rio-online.*offline/);
});

it('rejects a claimed namespace that still shows other interfaces', () => {
  const check = () =>
    checkLoopbackOnly({
      env: { ...ci, RIOSOMA_LOOPBACK_ONLY: '1' },
      platform: 'linux',
      interfaces: ['lo', 'rio-online', 'eth0', 'docker0'],
    });
  expect(check).toThrow(/eth0/);
  expect(check).toThrow(/docker0/);
});

it('warns instead of failing when the namespace is unavailable', () => {
  const { warning } = checkLoopbackOnly({
    env: { ...ci, RIOSOMA_LOOPBACK_ONLY: 'unavailable' },
    platform: 'linux',
    interfaces: ['lo', 'eth0'],
  });
  expect(warning).toBeTruthy();
  expect(warning).toMatch(/unavailable/);
});

it.each(['0', 'yes', ''])('rejects the unexpected value %j', (mode) => {
  expect(() =>
    checkLoopbackOnly({
      env: { ...ci, RIOSOMA_LOOPBACK_ONLY: mode },
      platform: 'linux',
      interfaces: ['lo'],
    }),
  ).toThrow(/unexpected value/);
});
