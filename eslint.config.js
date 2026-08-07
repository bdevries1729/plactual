import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // Server code and tooling: ES modules on Node.
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Served straight to the browser as a classic script. Plaid Link is a
    // global from the CDN bundle loaded in index.html.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, Plaid: 'readonly' },
    },
  },
  {
    rules: {
      // `ignoreRestSiblings` allows the "drop a key" idiom, e.g. stripping
      // access_token with `const { access_token: _t, ...rest } = mapping`.
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
];
