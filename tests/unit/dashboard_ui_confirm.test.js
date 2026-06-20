/**
 * @fileoverview showConfirmDialog のフォーム値取りこぼし回帰テスト
 *
 * 確定(保存)ボタン押下時、従来は resolve より前に DOM を破棄していたため
 * await 直後の `document.getElementById(...)` が null になり、html 入力を持つ
 * 全ダイアログ（接続先設定の表示名/カメラ・HTTPポート、フィラメント装着先選択 等）の
 * 保存処理が値を取りこぼし「保存しても変わらない」ダミー化していた。
 *
 * 本テストは、確定後も await 継続（マイクロタスク）内でフォーム値を読み取れること、
 * かつ最終的に（次のマクロタスクで）オーバーレイが除去されることを検証する。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { showConfirmDialog } from "../../3dp_lib/dashboard_ui_confirm.js";

/** confirm ダイアログの確定ボタンを取得 */
function confirmBtn() {
  return document.querySelector(".confirm-button.confirm-destructive");
}
/** confirm ダイアログのキャンセルボタンを取得（confirm-safe の最後） */
function cancelBtn() {
  const btns = document.querySelectorAll(".confirm-button.confirm-safe");
  return btns[btns.length - 1];
}

describe("showConfirmDialog フォーム値取りこぼし回帰", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("確定後、await 継続内で getElementById が入力値を読める（取りこぼさない）", async () => {
    const p = showConfirmDialog({
      level: "info",
      title: "t",
      html: `<input type="text" id="edit-label" value="">`,
      confirmText: "保存",
      cancelText: "キャンセル"
    });
    // ダイアログは同期生成 → 入力にユーザー値をセット
    const input = document.getElementById("edit-label");
    expect(input).not.toBeNull();
    input.value = "Ideaformer-改";

    // 保存クリック
    confirmBtn().click();
    const result = await p;
    expect(result).toBe(true);

    // ★ await 継続(マイクロタスク)では DOM がまだ存在し値を読める
    expect(document.getElementById("edit-label")?.value).toBe("Ideaformer-改");
  });

  it("確定後に保持した要素参照からも値を読める（detach 後も value 保持の二重防御）", async () => {
    const p = showConfirmDialog({
      title: "t",
      html: `<input type="number" id="edit-http-port" value="80">`,
      confirmText: "保存",
      cancelText: "キャンセル"
    });
    const ref = document.getElementById("edit-http-port"); // await 前に捕捉
    ref.value = "7125";
    confirmBtn().click();
    await p;
    // マクロタスクまで進めて DOM 破棄を完了させる
    await new Promise(r => setTimeout(r, 0));
    // DOM からは消えていても、捕捉済み参照は value を保持
    expect(document.getElementById("edit-http-port")).toBeNull();
    expect(ref.value).toBe("7125");
  });

  it("確定直後はオーバーレイが残り、次のマクロタスクで除去される", async () => {
    const p = showConfirmDialog({ title: "t", confirmText: "OK", cancelText: "キャンセル" });
    confirmBtn().click();
    await p;
    expect(document.querySelector(".confirm-overlay")).not.toBeNull(); // 同 tick では残存
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector(".confirm-overlay")).toBeNull();     // 除去済み
  });

  it("キャンセルは false を resolve する", async () => {
    const p = showConfirmDialog({ title: "t", confirmText: "保存", cancelText: "キャンセル" });
    cancelBtn().click();
    expect(await p).toBe(false);
  });

  it("二重クリックしても一度だけ resolve（_settled ガード）", async () => {
    const p = showConfirmDialog({ title: "t", confirmText: "保存", cancelText: "キャンセル" });
    const btn = confirmBtn();
    btn.click();
    btn.click(); // 2回目は無視される
    expect(await p).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    // オーバーレイは1枚だけ生成され、確実に除去される（多重除去で例外を出さない）
    expect(document.querySelectorAll(".confirm-overlay").length).toBe(0);
  });
});
