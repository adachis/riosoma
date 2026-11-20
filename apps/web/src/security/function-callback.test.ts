import { expect, it } from 'vitest';
import { functionCallback } from './function-callback';

it('retains functions and rejects executable strings before timer scheduling', () => {
  const callback = () => 42;
  expect(functionCallback(callback)).toBe(callback);
  expect(functionCallback(callback)()).toBe(42);
  expect(() => functionCallback('attack()' as unknown as typeof callback)).toThrow(
    'Timer callbacks must be functions',
  );
});
