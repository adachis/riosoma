import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { LIMITS } from '@riosoma/contracts';

/** Names a newly created view or a copy within its table. */
export function availableViewName(i18n: I18n, name: string, names: readonly string[], copy = false): string {
  const used = new Set(names.map((value) => value.trim().toLowerCase()));
  const format = (name: string, number: number) => {
    const base = copy ? i18n._(msg({ id: 'database.copyView', message: `${name} copy` })) : name;
    return number === 1 ? base : i18n._(msg({ id: 'database.numberedView', message: `${base} (${number})` }));
  };
  for (let number = 1; ; number++) {
    const characters = Array.from(name.trim());
    let candidate = format(characters.join(''), number);
    // Reserve room for the translated suffix without cutting a character's surrogate pair.
    while (candidate.length > LIMITS.nameLength && characters.length) {
      characters.pop();
      candidate = format(characters.join(''), number);
    }
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
