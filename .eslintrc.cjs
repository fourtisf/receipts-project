/** Root ESLint config (ESLint 8, legacy config so `next lint` works in apps/web). */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    '.next',
    'coverage',
    'packages/contracts/out',
    'packages/contracts/cache',
    'packages/contracts/lib',
    'prototype',
    'reference',
    '*.config.js',
    '*.config.cjs',
    '*.config.mjs',
    'next-env.d.ts',
  ],
};
