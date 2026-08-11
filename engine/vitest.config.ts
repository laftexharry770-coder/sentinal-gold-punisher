import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace dependency from source so `npm test` works on a
      // fresh clone, before anything has been built.
      '@sentinal/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
});
