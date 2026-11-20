import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../types.js';
import { decodeValue, encodeValue, errorFromWire, errorToWire } from './protocol.js';

const data = () => JSON.parse('{"__proto__":{"nested":true},"constructor":"cell","$rio":"column"}');

function expectData(value: unknown): void {
  expect(value).toEqual(data());
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
    value: { nested: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

describe('wire object keys', () => {
  it('preserves own data properties in rows, parameters, and nested objects', () => {
    const source = { rows: [{ values: data() }], params: data(), nested: { object: data() } };
    const encoded = encodeValue(source) as typeof source;
    for (const value of [encoded.rows[0]!.values, encoded.params, encoded.nested.object]) {
      const wrapped = value as { v: unknown };
      expectData(wrapped.v);
    }
    const decoded = decodeValue(JSON.parse(JSON.stringify(encoded))) as typeof source;
    expectData(decoded.rows[0]!.values);
    expectData(decoded.params);
    expectData(decoded.nested.object);
  });

  it('decodes untagged objects without changing their prototype', () => {
    const decoded = decodeValue(JSON.parse('{"__proto__":{"inherited":true},"nested":{"__proto__":7}}'));
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded).toHaveProperty('__proto__', { inherited: true });
    expect(decoded).not.toHaveProperty('inherited');
    const nested = (decoded as { nested: object }).nested;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
  });

  it('preserves error parameters through JSON', () => {
    const wire = JSON.parse(
      JSON.stringify(errorToWire(new ConnectorError('sources.sync.read', undefined, data()))),
    );
    expectData((errorFromWire(wire) as ConnectorError).params);
  });
});
