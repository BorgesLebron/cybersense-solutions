module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  clearMocks: true,
  restoreMocks: true,
  setupFiles: ['<rootDir>/test/setup-env.js'],
};
