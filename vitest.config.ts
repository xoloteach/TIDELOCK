import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@content': fileURLToPath(new URL('./content', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/saves/**/*.test.ts',
    ],
    exclude: ['tests/browser/**', 'tests/visual/**', 'tests/performance/**', 'node_modules/**'],
    // Fail loudly instead of silently swallowing unhandled rejections.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
