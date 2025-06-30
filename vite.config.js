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
* @version 1.390.587 (PR #272)
* @since   1.390.534 (PR #244)
* @lastModified 2025-06-30 06:29:30
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
        additionalData: (content, filename) => {
          return filename.endsWith('styles/root.scss')
            ? content
            : `@use 'styles/root';\n${content}`;
        }
      }
    }
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@cards': path.resolve(__dirname, 'src/cards'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      'styles': path.resolve(__dirname, 'styles')
    }
  },
  server: {
    port: 5173,
    open: true,
    strictPort: true
  }
});
