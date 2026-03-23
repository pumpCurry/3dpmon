import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // テストファイルのパターン
    include: ['tests/**/*.test.js'],
    // ESM モードで実行
    environment: 'node',
    // グローバルAPI（describe, it, expect）を自動インポート
    globals: true,
    // タイムアウト（ms）
    testTimeout: 10000,
    // カバレッジ設定（将来用）
    coverage: {
      provider: 'v8',
      include: ['3dp_lib/**/*.js'],
      exclude: ['3dp_lib/3dp_errorcode.js'],
    },
  },
});
