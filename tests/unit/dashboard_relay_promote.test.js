/**
 * dashboard_relay_bridge.js 昇格PIN検証テスト
 *
 * 仕様:
 *   - 親に PIN 未設定(空) → 確認のみで昇格許可 (granted=true)
 *   - PIN 設定済み + 入力一致 → 許可
 *   - PIN 設定済み + 入力空 → 拒否 reason="pin-required"
 *   - PIN 設定済み + 入力不一致 → 拒否 reason="pin-mismatch"
 *   - PIN は親(appSettings)のみが保持。子は参照不可。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: { appSettings: { relayPromotePin: '' }, machines: {} },
  PLACEHOLDER_HOSTNAME: '_$_NO_MACHINE_$_',
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({
  sendCommand: vi.fn(),
}));

const { verifyPromotePin, buildCameraEndpoints } = await import('../../3dp_lib/dashboard_relay_bridge.js');

describe('verifyPromotePin — 昇格PIN検証', () => {
  it('PIN未設定(空)なら入力に関わらず許可', () => {
    expect(verifyPromotePin('', '')).toEqual({ granted: true, reason: '' });
    expect(verifyPromotePin('anything', '')).toEqual({ granted: true, reason: '' });
    expect(verifyPromotePin(null, '   ')).toEqual({ granted: true, reason: '' }); // 空白のみも未設定扱い
  });

  it('PIN設定済み + 一致 → 許可', () => {
    expect(verifyPromotePin('1234', '1234')).toEqual({ granted: true, reason: '' });
  });

  it('PIN設定済み + 前後空白は許容して一致判定', () => {
    expect(verifyPromotePin(' 1234 ', '1234')).toEqual({ granted: true, reason: '' });
  });

  it('★PIN設定済み + 入力空 → pin-required', () => {
    expect(verifyPromotePin('', '1234')).toEqual({ granted: false, reason: 'pin-required' });
    expect(verifyPromotePin(null, '1234')).toEqual({ granted: false, reason: 'pin-required' });
    expect(verifyPromotePin('   ', '1234')).toEqual({ granted: false, reason: 'pin-required' });
  });

  it('★PIN設定済み + 不一致 → pin-mismatch', () => {
    expect(verifyPromotePin('0000', '1234')).toEqual({ granted: false, reason: 'pin-mismatch' });
    expect(verifyPromotePin('12345', '1234')).toEqual({ granted: false, reason: 'pin-mismatch' });
  });

  it('configuredPin 省略時は appSettings.relayPromotePin を参照（既定は空=許可）', () => {
    // モックの monitorData.appSettings.relayPromotePin は ''
    expect(verifyPromotePin('whatever')).toEqual({ granted: true, reason: '' });
  });

  it('数値型PINでも文字列化して比較', () => {
    expect(verifyPromotePin(1234, 1234)).toEqual({ granted: true, reason: '' });
  });
});

describe('buildCameraEndpoints — カメラパススルー用エンドポイントマップ構築', () => {
  it('hostname/dest からIP+ポートを構築（cameraPort 優先）', () => {
    const targets = [
      { dest: '192.168.1.10:9999', hostname: 'k1-max', cameraPort: 8081 },
      { dest: '192.168.1.11:9999', hostname: 'ender' },
    ];
    expect(buildCameraEndpoints(targets, 8080)).toEqual({
      'k1-max': { ip: '192.168.1.10', port: 8081 },
      'ender': { ip: '192.168.1.11', port: 8080 },
    });
  });

  it('cameraPort も既定も無ければ 8080 にフォールバック', () => {
    expect(buildCameraEndpoints([{ dest: '10.0.0.5:80', hostname: 'h' }])).toEqual({
      'h': { ip: '10.0.0.5', port: 8080 },
    });
  });

  it('hostname 未解決(空)のターゲットはスキップ', () => {
    const targets = [
      { dest: '192.168.1.10:9999', hostname: '' },
      { dest: '192.168.1.11:9999', hostname: '  ' },
      { dest: '192.168.1.12:9999', hostname: 'ok' },
    ];
    expect(buildCameraEndpoints(targets, 8080)).toEqual({
      'ok': { ip: '192.168.1.12', port: 8080 },
    });
  });

  it('dest にIPが無ければスキップ', () => {
    expect(buildCameraEndpoints([{ dest: '', hostname: 'h' }], 8080)).toEqual({});
    expect(buildCameraEndpoints([{ dest: ':8080', hostname: 'h' }], 8080)).toEqual({});
  });

  it('同一 hostname は後勝ち', () => {
    const targets = [
      { dest: '192.168.1.10:9999', hostname: 'dup' },
      { dest: '192.168.1.99:9999', hostname: 'dup' },
    ];
    expect(buildCameraEndpoints(targets, 8080)).toEqual({
      'dup': { ip: '192.168.1.99', port: 8080 },
    });
  });

  it('配列以外/空は空オブジェクト', () => {
    expect(buildCameraEndpoints(null)).toEqual({});
    expect(buildCameraEndpoints(undefined)).toEqual({});
    expect(buildCameraEndpoints([])).toEqual({});
  });
});
