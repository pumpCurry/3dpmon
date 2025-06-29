/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 TempRingBuffer 単体テスト
 * @file tempbuffer.test.js
 * -----------------------------------------------------------
 * @module tests/tempbuffer
 *
 * 【機能内容サマリ】
 * - TempRingBuffer の push と toArray の挙動を検証
 *
 * @version 1.390.563 (PR #259)
 * @since   1.390.563 (PR #259)
 * @lastModified 2025-06-29 13:09:40
 */

import { describe, it, expect } from 'vitest';
import { TempRingBuffer } from '@shared/TempRingBuffer.js';

describe('TempRingBuffer', () => {
  it('stores data in order', () => {
    const buf = new TempRingBuffer(3);
    buf.push(1, 10, 20, 30);
    buf.push(2, 11, 21, 31);
    buf.push(3, 12, 22, 32);
    buf.push(4, 13, 23, 33);
    const arr = buf.toArray();
    expect(arr.length).toBe(3);
    expect(arr[0].time).toBe(2);
    expect(arr[2].hotend).toBe(13);
  });
});
