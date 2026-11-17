import { defineConfig } from 'vitest/config';

// Unit tests only; Playwright specs in e2e/ run with `pnpm e2e` / `pnpm e2e:fork`.
export default defineConfig({
  test: { exclude: ['e2e/**', 'node_modules/**', '.next/**', '.next-e2e/**'], passWithNoTests: true },
});
