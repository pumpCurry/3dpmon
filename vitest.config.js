import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    coverage: { reporter: ['text', 'lcov'] }
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@cards': path.resolve(__dirname, 'src/cards'),
      '@bars': path.resolve(__dirname, 'src/bars'),
      '@dialogs': path.resolve(__dirname, 'src/dialogs')
    }
  }
});
