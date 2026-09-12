import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'openapi/**', '*.config.js', '*.config.ts', '*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // infra-1: jest's globalSetup is loaded by jest itself (not swc), so it
    // stays CommonJS — the flat config's default ESM parse flags every
    // `require`/`module`/`process` in it.
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
);
