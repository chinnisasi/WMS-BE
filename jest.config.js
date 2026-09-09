/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    // TypeScript sources use the repo .swcrc (decorators); plain .js in
    // node_modules (e.g. postgres) must parse as ECMAScript, not TS.
    '^.+\\.ts$': ['@swc/jest', { configFile: './.swcrc' }],
    '^.+\\.m?js$': [
      '@swc/jest',
      { jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' }, module: { type: 'commonjs' } },
    ],
  },
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // The e2e suites share one Postgres database, so suites running in parallel
  // workers race each other's fixtures: a relay drain in one suite consumes
  // another suite's pending outbox rows (and reconciliation drives real
  // cross-tenant cycles). One suite at a time keeps the shared-DB e2e
  // deterministic; the suites are fast enough that this costs little.
  maxWorkers: 1,
  // NestJS 12 ships ESM-only packages; transform them to CJS for Jest.
  transformIgnorePatterns: [],
  restoreMocks: true,
};
