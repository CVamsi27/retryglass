import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `templates/regression.test.ts` is written into other projects by `retryglass export`; it imports
    // the installed package and must never run from this repository's root test run.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
  },
});
