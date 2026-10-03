import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Limita disputa por CPU/memória no CI e evita timeouts em inicialização de rotas.
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
