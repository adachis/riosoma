import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Isolation gives frame measurements enough clock precision to distinguish the 16.7 ms budget.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
