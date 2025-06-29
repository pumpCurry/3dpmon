/**
 * @fileoverview
 * @description TempGraphCard FPS benchmark
 * @file tempgraph.bench.js
 * @module bench/tempgraph
 *
 * 【機能内容サマリ】
 * - TempGraphCard の描画 FPS を10秒間計測
 *
 * @version 1.390.563 (PR #259)
 * @since   1.390.563 (PR #259)
 * @lastModified 2025-06-29 13:09:40
 */

import { Window } from 'happy-dom';
const window = new Window();
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.window = window;
globalThis.document = window.document;
import bench from 'nanobench';
import TempGraph from '../src/cards/Card_TempGraph.js';
import { bus } from '../src/core/EventBus.js';

bench('tempgraph fps', async b => {
  const card = new TempGraph(bus);
  card.init();
  card.mount(document.body);
  let frames = 0;
  card.onFrame = () => { frames++; };
  b.start();
  await window.happyDOM.whenAsyncComplete();
  await new Promise(r => setTimeout(r, 1000));
  await window.happyDOM.whenAsyncComplete();
  b.end();
  card.destroy();
  const fps = frames / 1;
  b.log(`FPS: ${fps}`);
  if (fps < 60) throw new Error('FPS < 60');
});
