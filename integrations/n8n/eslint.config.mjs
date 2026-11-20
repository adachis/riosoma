import { configs } from '@n8n/eslint-plugin-community-nodes';
import root from '../../eslint.config.js';

// The repository's rules, plus the checks n8n runs before it verifies a community node.
export default [
  ...root,
  {
    ...configs.recommended,
    files: ['credentials/**/*.ts', 'nodes/**/*.ts', 'shared/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      ...configs.recommended.rules,
      // The package names the project rather than a person, and npm needs no email to publish.
      '@n8n/community-nodes/valid-author': 'off',
    },
  },
];
