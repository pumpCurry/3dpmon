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
 * @version 1.390.618 (PR #286)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-02 09:09:00
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
});
