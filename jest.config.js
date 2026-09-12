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
  // infra-1 gave every e2e suite its own database, so the fixture races are
  // gone, but the suites still share one Postgres SERVER: its connection
  // budget (two pools per booted app) and its CPU. One suite at a time keeps
  // that bounded; the suites are fast enough that this costs little.
  maxWorkers: 1,
  // NestJS 12 ships ESM-only packages; transform them to CJS for Jest.
  transformIgnorePatterns: [],
  // See test/http-agent.setup.ts — keep-alive pooling against per-request
  // ephemeral servers is a cross-talk hazard, not an optimisation, here.
  setupFiles: ['<rootDir>/test/http-agent.setup.ts'],
  // infra-1: builds the `wms_template` database once per run; each e2e suite
  // clones it so no two suites share state. See test/support/suite-db.ts.
  globalSetup: '<rootDir>/test/support/global-setup.js',
  restoreMocks: true,
};
