import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-dev/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The simulation core must stay DOM-free and independent of the view/runtime layers.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'src/core must not import three.' },
            { group: ['uplot', 'uplot/*'], message: 'src/core must not import uplot.' },
            {
              group: ['**/view', '**/view/*', '**/element', '**/element/*', '**/runtime', '**/runtime/*'],
              message: 'src/core must not import from view, element or runtime.',
            },
          ],
        },
      ],
    },
  },
);
