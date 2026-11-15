import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 900000,
    hookTimeout: 900000,
    include: ['bench/**/*.bench.ts'],
  },
});
