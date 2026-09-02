import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import prettierConfig from 'eslint-config-prettier';

const TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS = [
  {
    regex: '(^|/)dashboard_material_accounting_contract\\.js$',
    importNames: ['createTrustedPrintStartMaterialAccountingPrintBindingRepository'],
    message: 'Trusted print binding repository factory is runtime-internal; import it only from dashboard_material_accounting_print_binding_runtime.js.',
  },
  {
    regex: '(^|/)dashboard_material_accounting_print_binding_repository\\.js$',
    importNames: ['createMaterialAccountingPrintBindingRepositoryWithIssuer'],
    message: 'Issuer-injected print binding repository is contract-internal; import it only from dashboard_material_accounting_contract.js.',
  },
  {
    regex: '(^|/)dashboard_material_accounting_print_binding_runtime\\.js$',
    importNames: ['createMaterialAccountingPrintBindingRuntimeForTest'],
    message: 'Test-only print binding runtime factory must not be imported by production modules.',
  },
  {
    regex: '(^|/)dashboard_itemkeeper_source_usage_projection_certification\\.js$',
    importNames: [
      'clearItemKeeperSourceUsageProjectionCertificationsForTest',
      'registerItemKeeperSourceUsageProjectionCertificationForTest',
    ],
    message: 'ItemKeeper source usage projection test issuer must not be imported by production modules.',
  },
];

const TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS_FOR_CONTRACT = TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS
  .filter((restriction) => !restriction.importNames.includes('createMaterialAccountingPrintBindingRepositoryWithIssuer'));

const TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS_FOR_RUNTIME = TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS
  .filter((restriction) => !restriction.importNames.includes('createTrustedPrintStartMaterialAccountingPrintBindingRepository'));

export default [
  js.configs.recommended,
  jsdoc.configs['flat/recommended'],
  prettierConfig,
  {
    files: ['3dp_lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // ブラウザグローバル
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLInputElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        performance: 'readonly',
        Notification: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        speechSynthesis: 'readonly',
        Audio: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        structuredClone: 'readonly',
      },
    },
    plugins: {
      jsdoc,
    },
    rules: {
      // --- AGENTS.md 準拠: JSDoc 必須 ---
      'jsdoc/require-jsdoc': ['warn', {
        require: {
          FunctionDeclaration: true,
          FunctionExpression: true,
          ArrowFunctionExpression: false,
          MethodDefinition: true,
        },
      }],
      'jsdoc/require-param': 'warn',
      'jsdoc/require-param-type': 'warn',
      'jsdoc/require-returns': 'warn',
      'jsdoc/require-returns-type': 'warn',
      'jsdoc/require-description': 'off',

      // --- 基本品質ルール ---
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'warn',
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'prefer-const': 'warn',

      // --- 初期導入のため一部ルールを緩和 ---
      'no-prototype-builtins': 'off',
      'no-fallthrough': 'warn',
      'no-restricted-imports': ['error', {
        patterns: TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS,
      }],
    },
  },
  {
    files: ['3dp_lib/printer_core/dashboard_material_accounting_contract.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS_FOR_CONTRACT,
      }],
    },
  },
  {
    files: ['3dp_lib/printer_core/dashboard_material_accounting_print_binding_runtime.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: TRUSTED_PRINT_BINDING_IMPORT_RESTRICTIONS_FOR_RUNTIME,
      }],
    },
  },
  {
    // テストファイル用の設定
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // vitest グローバル
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        // jsdom / Node テスト環境グローバル（@vitest-environment jsdom / node）。
        // これらは各テストの実行環境が提供する。未列挙だと no-undef が多発していた。
        global: 'readonly',
        globalThis: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        matchMedia: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'electron/',
      'scripts/',
      '*.tmp.*',
    ],
  },
];
