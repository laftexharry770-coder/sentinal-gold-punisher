import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Resolve the workspace packages to their sources so the tests never depend on
 * a prior `npm run build` having produced their dist output.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sentinal/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@sentinal/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
