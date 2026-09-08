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
  // NestJS 12 ships ESM-only packages; transform them to CJS for Jest.
  transformIgnorePatterns: [],
  restoreMocks: true,
};
