/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Vite 設定ファイル
 * @file vite.config.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module vite-config
 *
 * 【機能内容サマリ】
 * - Vite の基本ビルド設定を提供する
 *
 * @version 1.390.534 (PR #244)
 * @since   1.390.534 (PR #244)
 * @lastModified 2025-06-30 19:07:40
 */

import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },

  css: {
    preprocessorOptions: {
      scss: {
        /**
         * 自動で tokens を差し込む
         * ただし styles/root.scss 自身には挿入しない (無限ループ回避)
         */
        additionalData(source, filename) {
          // Windows パスは \ 区切りになるので path.normalize で統一
          const normalized = path.normalize(filename);
          if (normalized.endsWith(path.normalize('styles/root.scss'))) {
            return source; // そのまま返す
          }
          return `@use 'styles/root' as *;\n${source}`;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@cards': path.resolve(__dirname, 'src/cards'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@dialogs': path.resolve(__dirname, 'src/dialogs')
    }
  },
  server: {
    port: 5173,
    open: true,
    strictPort: true,
    watch: {
      usePolling: true,      // inotify が効かないドライブをポーリング
      interval: 150,         // ms  デフォ 100 → Dropbox は遅延が大きいので 300–500 推奨
    },
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
  }
});
