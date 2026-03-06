# FreeVoice 不具合調査レポート

調査日: 2026-03-05

---

## 現象

- `Ctrl+Shift+Space` を押しても画面に何も起きない
- 別のショートカット（`Ctrl+Shift+Alt+A` 等）に変えても同様
- 設定画面で値を変更して「保存」を押しても何も反応しない

---

## 調査した範囲

| ファイル | 内容 |
|---|---|
| `src-tauri/src/lib.rs` | Rust バックエンド全体 |
| `src/Overlay.tsx` | オーバーレイウィンドウのコンポーネント |
| `src/App.tsx` | 設定画面のコンポーネント |
| `src/transcription.ts` | WebSocket 録音セッション |
| `src/postprocess.ts` | 後処理（Chat Completions 呼び出し） |
| `src/useSettings.ts` | 設定の読み書き |
| `src-tauri/tauri.conf.json` | Tauri アプリ設定 |
| `src-tauri/capabilities/default.json` | Tauri v2 権限設定 |
| `src-tauri/gen/schemas/acl-manifests.json` | 生成済み ACL マニフェスト（権限定義の確認に使用） |

---

## 発見した問題

### 問題1：Capabilities ファイルが存在しなかった【修正済み・ただし不完全】

`src-tauri/capabilities/default.json` が存在しなかったため、フロントエンドの IPC が一切機能しない状態だった。ファイルは以下の内容で作成済み：

```json
{
  "windows": ["main", "overlay"],
  "permissions": ["core:default"]
}
```

しかし、**この状態ではまだ動かない。** 問題1aを参照。

---

### 問題1a：`core:default` に `allow-show` / `allow-hide` が含まれていない【現在の根本原因】

Tauri v2 の `core:default` に含まれる `core:window:default` は、ウィンドウの位置・サイズ取得などのクエリ系のみを許可しており、**`allow-show` と `allow-hide` は含まれていない**。これらは明示的に追加が必要な別権限である。

#### 障害の連鎖

```
Overlay.tsx の useEffect が起動
  → listen("recording-start", ...) → OK（core:event:default に含まれる）
  → イベントリスナーは登録される
```

```
ユーザーがショートカットを押す
  → Rust 側が正常に emit("recording-start")
  → handleStart() が呼ばれる
    → await appWindow.show()  ← core:window:allow-show が不足 → 例外を投げる
  → handleStart() は .catch() なしで呼ばれているためエラーが無視される
  → オーバーレイが表示されないまま
```

つまり、イベント受信まではできているが、**オーバーレイを表示する段階で権限エラーがサイレントに発生している**。

#### Tauri v2 の権限モデルの整理

| 権限 | `core:default` に含まれるか |
|---|---|
| `core:event:allow-listen` | ✅ 含まれる（`core:event:default` 経由） |
| `core:event:allow-emit` | ✅ 含まれる |
| `core:window:allow-show` | ❌ 含まれない・要明示 |
| `core:window:allow-hide` | ❌ 含まれない・要明示 |
| アプリ定義コマンド（`generate_handler!`）| ✅ ACL 対象外・常に許可 |

#### 対処

`src-tauri/capabilities/default.json` に 2 つの権限を追加する：

```json
{
  "windows": ["main", "overlay"],
  "permissions": [
    "core:default",
    "core:window:allow-show",
    "core:window:allow-hide"
  ]
}
```

#### サイレント失敗の構造（コードの問題点）

`handleStart()` が `.catch()` なしで呼ばれているため、`appWindow.show()` の失敗が検出されない：

```ts
// Overlay.tsx:23-25
const unlistenStart = await listen("recording-start", () => {
  handleStart();  // ← await なし・.catch() なし
});
```

また `setupListeners()` の呼び出しも同様：

```ts
// Overlay.tsx:36
setupListeners().then((fn) => { cleanup = fn; });
// ← .catch() がない
```

---

### 問題2：保存ボタンに視覚フィードバックがない

`App.tsx` の `handleSave()` は `saveSettings(form)` を呼ぶだけで、完了時のメッセージ表示がない。

```tsx
// App.tsx:15-17
const handleSave = () => {
  saveSettings(form);
  // ← 成功メッセージなし
};
```

設定の保存自体は正しく `localStorage` に書き込まれている。
しかしユーザーから見ると「保存しても何も起きない」ように見える。

#### 対処

`handleSave` 実行後に一時的な「保存しました」メッセージを表示する。
`testStatus` と同様の state を使うか、簡易なフラッシュ表示を追加する。

---

### 問題3：ショートカットキー設定が Rust 側と未接続

設定画面の `shortcut` フィールドを変更・保存しても、**実際のグローバルショートカットは変わらない**。

`lib.rs:256` でショートカットがハードコードされており、`localStorage` の値は読まれない。

```rust
// lib.rs:256
app.global_shortcut()
    .on_shortcut("Ctrl+Shift+Space", ...)  // ← 固定値
```

- 設定画面の `shortcut` フィールドは現時点では Dead code
- `CLAUDE.md` にも「設定画面の shortcut フィールドは未接続」と記載済み

#### 対処方針（別途設計が必要）

1. Rust に新コマンド `update_shortcut(shortcut: String)` を追加
2. 設定保存時にフロントから `invoke("update_shortcut", { shortcut })` を呼ぶ
3. Rust 側で既存ショートカットを解除して新規登録し直す

---

### 問題4：`start_transcription` でセッション更新のモデルがハードコード【軽微】

`lib.rs:114` の `session.update` メッセージで `input_audio_transcription.model` が `"gpt-4o-transcribe"` に固定されている。
引数 `model` は WebSocket URL の構築には使われているが、セッション設定には反映されていない。

```rust
// lib.rs:114
"input_audio_transcription": {
    "model": "gpt-4o-transcribe"  // ← 引数 model が使われていない
},
```

現在のデフォルト値が `"gpt-4o-transcribe"` なので実害はないが、将来変更した場合に気づきにくい。

#### 対処

`"gpt-4o-transcribe"` の箇所を引数 `model` の値に置き換える。

---

### 問題5：`tauri-plugin-clipboard-manager` が登録されているが未使用

`lib.rs:206` で `tauri_plugin_clipboard_manager::init()` を登録しているが、アプリ内のどこにも使われていない。
`paste_text` コマンドは `enigo` クレートで直接テキスト入力しており、クリップボードは使用しない設計になっている。

---

## 優先度まとめ

| # | 問題 | 状態 | 影響 | 優先度 |
|---|---|---|---|---|
| 1 | Capabilities ファイルなし | 修正済み（不完全） | — | — |
| 1a | `allow-show` / `allow-hide` 不足 | **未修正** | アプリが動かない根本原因 | **高（即修正）** |
| 2 | 保存ボタンのフィードバックなし | 未修正 | UX の問題 | 中 |
| 3 | ショートカット設定が未接続 | 未修正（既知）| 機能未実装 | 低（設計が必要） |
| 4 | `session.update` のモデルハードコード | 未修正 | 設定変更が効かない | 低 |
| 5 | `clipboard-manager` 未使用 | 未修正 | バイナリサイズ増 | 低 |
