import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The replayer bundles its worklet as text at build time; tests run the worklet in-process.
    alias: { 'virtual:replayer-worklet': fileURLToPath(new URL('packages/replayer/src/test-worklet-code.ts', import.meta.url)) },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test-*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Floors a little under the current numbers, so coverage can only go down on purpose.
      thresholds: {
        lines: 58,
        'packages/engine/src/**': { lines: 97, branches: 86 },
        'packages/formats/src/**': { lines: 92, branches: 72 },
        'packages/replayer/src/**': { lines: 96, branches: 86 },
        'packages/app/src/**': { lines: 19 },
      },
    },
  },
});
