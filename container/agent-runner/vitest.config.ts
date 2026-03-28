import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Manual OpenRouter script, not a Vitest suite
    exclude: ['src/ai-call.test.ts'],
  },
});
