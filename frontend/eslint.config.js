import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

// Correctness only: this first pass is meant to catch real defects, not to
// reformat 10k existing lines. Style rules join later, one sweep at a time.
export default [
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^[A-Z_]' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'vue/multi-word-component-names': 'off',
      'vue/no-mutating-props': 'error'
    }
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } }
  },
  {
    // These suites import Vue sources with node:test and stub globals on purpose.
    files: ['tests/**/*.test.js'],
    rules: { 'no-undef': 'off', 'no-empty': 'off' }
  },
  {
    // Browser suites mount real components and assert on them.
    files: ['tests/browser/**/*.cjs', 'scripts/**/*.cjs'],
    rules: { 'no-undef': 'off', 'no-empty': 'off' }
  },
  { ignores: ['dist/**', 'node_modules/**', 'public/pdfjs/**'] }
]
