/**
 * @fileoverview
 * @description HeadPreviewCard FPS benchmark
 * @file headpreview.bench.js
 * @module bench/headpreview
 *
 * 【機能内容サマリ】
 * - HeadPreviewCard の描画 FPS を5秒間計測
 *
 * @version 1.390.561 (PR #258)
 * @since   1.390.561 (PR #258)
 * @lastModified 2025-06-29 12:14:44
 * -----------------------------------------------------------
 */
import { Window } from "happy-dom";
const window = new Window();
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.window = window;
globalThis.document = window.document;
import bench from 'nanobench';
import HeadPreviewCard from '../src/cards/Card_HeadPreview.js';
import { bus } from '../src/core/EventBus.js';

bench('headpreview fps', async b => {
  const card = new HeadPreviewCard(bus);
  card.init({ position: { x: 0, y: 0, z: 0 }, model: 'K1' });
  card.mount(document.body);
  let frames = 0;
  card.onFrame = () => frames++;
  b.start();
  await window.happyDOM.whenAsyncComplete();
  await new Promise(r => setTimeout(r, 5000));
  await window.happyDOM.whenAsyncComplete();
  b.end();
  card.destroy();
  const fps = frames / 5;
  b.log(`FPS: ${fps}`);
  if (fps < 28) throw new Error('FPS < 28');
});
