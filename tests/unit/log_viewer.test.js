// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon logger utility tests
 * @file log_viewer.test.js
 * -----------------------------------------------------------
 * @module tests/log_viewer
 *
 * 【機能内容サマリ】
 * - logger buffer 操作とフィルタ機能を検証
 *
 * @version 1.390.620 (PR #287)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-01 18:43:23
 */

import { describe, it, expect, beforeEach } from 'vitest';
import logger from '@shared/logger.js';

describe('logger', () => {
  beforeEach(() => { logger.buffer.length = 0; });

  it('push stores messages', () => {
    logger.push('foo');
    expect(logger.buffer.length).toBe(1);
  });

  it('filter returns by prefix', () => {
    logger.push('[WS] ok');
    logger.push('[Error] bad');
    expect(logger.filter('WS')).toEqual(['[WS] ok']);
  });

  it('keeps max 1000 entries', () => {
    for (let i = 0; i < 1005; i++) {
      logger.push(String(i));
    }
    expect(logger.buffer.length).toBe(1000);
    expect(logger.buffer[0]).toBe('5');
  });
});
