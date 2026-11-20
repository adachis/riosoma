import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'signatures.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

it('styles only the feature’s own plain controls, never the parts of the design system’s', () => {
  // The design system's checkbox and text field render labels and inputs of their own, each with a
  // class.  A rule for every label or input in the feature reached those too: it set the consent
  // box above its wording, and drew a second border inside the signature pad's name field.
  const reaching = [...css.matchAll(/([^{}@]+)\{/g)]
    .flatMap((rule) => rule[1]!.split(','))
    .map((selector) => selector.trim())
    .filter((selector) =>
      /(?:^|[\s>+~(])(?:label|input|select|textarea)\b(?!:not\(\[class\]\))/.test(selector),
    );
  expect(reaching).toEqual([]);
});
