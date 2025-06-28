import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    coverage: { reporter: ['text', 'lcov'] }
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core')
    }
  }
});
