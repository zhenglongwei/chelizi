const eslint = require('@eslint/js');
const globals = require('globals');

module.exports = [
  eslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  { ignores: ['node_modules/', 'scripts/'] },
];
