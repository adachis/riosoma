import { describe, expect, it } from 'vitest';
import { keyBetween, normalKey } from './order-keys.js';

/** Compares two decimals exactly, the way the database orders them. */
function less(a: string, b: string): boolean {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const whole = (text: string) => {
    const [int, fraction = ''] = text.split('.');
    return (
      BigInt(`${int!.replace('-', '')}${fraction.padEnd(scale, '0')}`) * (text.startsWith('-') ? -1n : 1n)
    );
  };
  return whole(a) < whole(b);
}

describe('order keys', () => {
  it('picks the shortest decimal between two keys that isn’t a whole number', () => {
    expect(keyBetween('1', '2')).toBe('1.5');
    expect(keyBetween('1', '4')).toBe('2.5');
    expect(keyBetween('1.5', '2')).toBe('1.8');
    expect(keyBetween('1.9', '2')).toBe('1.95');
    expect(keyBetween('0.5', '1.5')).toBe('0.9');
    expect(keyBetween('-3', '-2')).toBe('-2.5');
    expect(keyBetween('1.25', '1.2501')).toBe('1.25005');
  });

  it('goes past the only neighbor there is, without reaching the next whole number', () => {
    expect(keyBetween(null, '1')).toBe('0.5');
    expect(keyBetween(null, '0.3')).toBe('0.2');
    expect(keyBetween(null, '-2')).toBe('-2.5');
    expect(keyBetween('7', null)).toBe('7.5');
    expect(keyBetween('7.9', null)).toBe('7.95');
    expect(keyBetween(null, null)).toBe('0.5');
  });

  it('always finds room, however often records land in the same gap', () => {
    let low = '41';
    const high = '42';
    for (let step = 0; step < 500; step++) {
      const key = keyBetween(low, high);
      expect(less(low, key) && less(key, high), `${low} < ${key} < ${high}`).toBe(true);
      expect(key).toContain('.');
      low = key;
    }
    let top = '42';
    for (let step = 0; step < 500; step++) {
      const key = keyBetween('41', top);
      expect(less('41', key) && less(key, top)).toBe(true);
      top = key;
    }
  });

  it('refuses keys with nothing between them, and writes each number one way', () => {
    expect(() => keyBetween('2', '2')).toThrow(RangeError);
    expect(() => keyBetween('3', '2')).toThrow(RangeError);
    expect(normalKey('1.500')).toBe('1.5');
    expect(normalKey('12')).toBe('12');
    expect(normalKey('-0.250')).toBe('-0.25');
  });
});
