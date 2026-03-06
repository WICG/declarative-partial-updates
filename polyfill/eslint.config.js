import globals from 'globals';
import pluginJs from '@eslint/js';

export default [
  {
    ignores: ['node_modules', 'dist/'],
  },

  // 1. Global Recommended Config
  pluginJs.configs.recommended,

  // 2. Base Configuration (Applied to all files)
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es6,
        ...globals.node,
        ...globals.mocha,
      },
    },
  },

  // 3. Override for wdio.conf.js
  {
    files: ['wdio.conf.js'],
    rules: {
      'max-len': 'off',
    },
  },

  // 4. Override for Test Files
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha, // Ensures mocha globals are present here too
        $: 'readonly',
        browser: 'readonly',
        expect: 'readonly',
      },
    },
    rules: {
      'no-invalid-this': 'off',
      'max-len': [
        'error',
        {
          ignorePattern: '^\\s*import|= require\\(|^\\s*it\\(|^\\s*describe\\(',
          ignoreUrls: true,
        },
      ],
    },
  },
];
