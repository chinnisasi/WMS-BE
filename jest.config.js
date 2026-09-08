/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', { configFile: './.swcrc' }],
  },
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // NestJS 12 ships ESM-only packages; transform them to CJS for Jest.
  transformIgnorePatterns: [],
  restoreMocks: true,
};