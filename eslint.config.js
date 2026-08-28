// Flat ESLint config. Deliberately small: the rules worth having here are the ones that
// catch what GJS will only tell you about at runtime, inside the compositor, in a log
// nobody is reading.

const gjsGlobals = {
    // GJS runtime
    imports: 'readonly',
    // GNOME Shell's own: only defined inside the compositor process, which is why nothing
    // under src/lib may touch it.
    global: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    console: 'readonly',
    pkg: 'readonly',
    ARGV: 'readonly',
    // Standard library GJS provides
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    globalThis: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
};

export default [
    {
        ignores: ['screenshots/**', 'result*/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        linterOptions: {
            reportUnusedDisableDirectives: true,
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { args: 'none' }],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            eqeqeq: ['error', 'smart'],
            'no-throw-literal': 'error',
            curly: ['error', 'multi-or-nest', 'consistent'],
            semi: ['error', 'always'],
        },
    },
];
