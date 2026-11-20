import { LIMITS } from '@riosoma/contracts';

/** A name with a number after it when the plain one is taken, ignoring case. */
export function uniqueName(taken: Set<string>, wanted: string, fallback: string): string {
  const base = wanted.trim().slice(0, LIMITS.nameLength) || fallback;
  let name = base;
  for (let number = 2; taken.has(name.toLowerCase()); number++) {
    const suffix = ` ${number}`;
    name = `${base.slice(0, LIMITS.nameLength - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}
