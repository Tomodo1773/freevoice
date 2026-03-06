# FreeVoice 実装計画

## Context
REQUIREMENTS.md に基づき、Windows向け音声入力アプリ「FreeVoice」をゼロから実装する。
Push-to-Talk方式でグローバルホットキーを押している間に録音し、Azure OpenAI（Microsoft Foundry）でリアルタイム文字起こし＋AI後処理してフォーカス中テキストフィールドに貼り付ける、Tauriアプリ。

---

## プロジェクト構成

```
freevoice/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html                     # 設定画面エントリ
├── overlay.html                   # オーバーレイエントリ
├── src/
│   ├── main.tsx                   # 設定画面 React エントリ
│   ├── overlay-main.tsx           # オーバーレイ React エントリ
│   ├── App.tsx                    # 設定画面コンポーネント
│   ├── Overlay.tsx                # オーバーレイUIコンポーネント
│   ├── types.ts                   # 共通型定義
│   ├── useSettings.ts             # 設定読み書きフック（localStorage）
│   ├── transcription.ts           # WebSocket Realtime API クライアント
│   ├── postprocess.ts             # Chat Completions API 呼び出し
│   └── app.css                    # スタイル
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── icons/                     # アプリアイコン（別途用意）
    └── src/
        ├── main.rs                # エントリポイント
        └── lib.rs                 # Tauri コマンド + セットアップ
```

---

## 技術スタック

| 層 | 技術 |
|---|---|
| フレームワーク | Tauri 2.x |
| フロントエンド | React 18 + TypeScript + Vite |
| グローバルホットキー | tauri-plugin-global-shortcut 2.x |
| クリップボード | tauri-plugin-clipboard-manager 2.x |
| システムトレイ | Tauri 標準 API |
| Ctrl+V シミュレーション | Rust: enigo クレート |
| クリック透過ウィンドウ | Rust: windows-sys クレート（Windows API） |

---

## 実装ステップ

### Step 1: プロジェクト初期化

```bash
# node_modules 削除
rm -rf node_modules

# Tauri プロジェクト作成
npm create tauri-app@latest . -- --template react-ts
# または手動で package.json / Cargo.toml を作成
```

**package.json の主要依存:**
```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-clipboard-manager": "^2",
    "@tauri-apps/plugin-global-shortcut": "^2",
    "react": "^18",
    "react-dom": "^18"
  }
}
```

**src-tauri/Cargo.toml の主要依存:**
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-clipboard-manager = "2"
enigo = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
[target.'cfg(target_os = "windows")'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation"] }
```

---

### Step 2: Tauri 設定（src-tauri/tauri.conf.json）

2ウィンドウ構成:
- `main`: 設定画面（起動時非表示、トレイから表示）
- `overlay`: オーバーレイ（透明・常前面・クリック透過）

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "url": "index.html",
        "title": "FreeVoice 設定",
        "width": 480,
        "height": 640,
        "visible": false,
        "decorations": true
      },
      {
        "label": "overlay",
        "url": "overlay.html",
        "title": "",
        "width": 600,
        "height": 80,
        "visible": false,
        "decorations": false,
        "transparent": true,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "center": false
      }
    ]
  },
  "plugins": {
    "global-shortcut": {},
    "clipboard-manager": {}
  }
}
```

---

### Step 3: Rust バックエンド（lib.rs）

```rust
// グローバルホットキー登録（Pressed/Released 両方検知）
app.global_shortcut().on_shortcut("Ctrl+Shift+Space", |app, _shortcut, event| {
    match event.state {
        ShortcutState::Pressed  => app.emit("recording-start", ()).ok(),
        ShortcutState::Released => app.emit("recording-stop",  ()).ok(),
    };
});

// システムトレイ設定
// 右クリックメニュー: 設定 / 終了
// ダブルクリック: main ウィンドウ表示

// Rust コマンド
#[tauri::command]
async fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    // 1. クリップボードにテキストを書き込み（enigo or clipboard-manager）
    // 2. enigo で Ctrl+V をシミュレート
}

#[tauri::command]
fn set_click_through(window: WebviewWindow) -> Result<(), String> {
    // Windows API: WS_EX_TRANSPARENT | WS_EX_LAYERED を設定
    // → ウィンドウへのクリックを透過させる
}

#[tauri::command]
fn position_overlay(window: WebviewWindow) -> Result<(), String> {
    // プライマリモニターの下部中央に配置
}
```

---

### Step 4: フロントエンド

#### overlay-main.tsx / Overlay.tsx

**状態管理:**
```typescript
type OverlayStatus = 'listening' | 'formatting' | 'done' | 'error';

// Tauri イベントリスナー
listen('recording-start', () => startRecording());
listen('recording-stop',  () => stopRecording());
```

**録音フロー（startRecording）:**
1. `navigator.mediaDevices.getUserMedia({ audio: true })` でマイク取得
2. `MediaRecorder` で音声キャプチャ
3. WebSocket 接続: `wss://{endpoint}/openai/v1/realtime?model={deployment}`
   - ヘッダー: `api-key: {apiKey}` → WebSocket はカスタムヘッダー不可のため、URLパラメータまたはTauri経由で対応
   - セッション設定: `{ type: "session.update", session: { modalities: ["text"], input_audio_transcription: { model: "gpt-4o-transcribe" }, language: "ja" } }`
4. 音声チャンクを Base64 エンコードして WebSocket 送信
5. `transcript.text.delta` イベントでリアルタイムテキスト更新

**停止フロー（stopRecording）:**
1. `MediaRecorder.stop()` / WebSocket close
2. status → `'formatting'`
3. AI後処理 API 呼び出し（postprocess.ts）
4. `invoke('paste_text', { text: formattedText })`
5. status → `'done'`
6. 1秒後にウィンドウを非表示

#### transcription.ts
- WebSocket クライアント（wss://）
- Azure OpenAI Realtime API のイベント処理
- `input_audio_buffer.append` でチャンク送信
- `conversation.item.input_audio_transcription.delta` でテキスト受信

**WebSocket 認証の注意:**
ブラウザの WebSocket はカスタムヘッダーを設定できないため、Tauri の WebSocket プロキシか、エンドポイントがサポートする場合は URL パラメータ（`?api-key={key}`）を使用する。

#### postprocess.ts
```typescript
// POST {endpoint}/openai/v1/chat/completions
// Headers: { "api-key": apiKey, "Content-Type": "application/json" }
// Body: {
//   model: postprocessModel,
//   messages: [system prompt + transcript],
//   reasoning_effort: "none"
// }
// System prompt: 誤字修正・句読点補完・フィラー除去の指示（日本語）
```

#### App.tsx（設定画面）
- フォーム: ショートカットキー / Endpoint / API Key / 文字起こしモデル / 後処理モデル
- 保存: localStorage に JSON 保存
- 接続テスト: Endpoint + API Key でダミーリクエスト送信して疎通確認

---

### Step 5: WebSocket 認証問題への対処

ブラウザ WebSocket はカスタムヘッダー不可。対処方法:

**方針A**: Rust側にWebSocketプロキシコマンドを作り、フロントエンドからinvokeで制御（最も確実）
**方針B**: Azure OpenAI Realtime APIがURLパラメータ認証をサポートしているか確認して使用

→ **方針A を採用**: Rust コマンド `start_transcription` / `stop_transcription` を実装し、Rust 側でWebSocket接続を管理。文字起こしテキストはTauriイベントでフロントエンドに送信。

```rust
#[tauri::command]
async fn start_transcription(app: AppHandle, endpoint: String, api_key: String, model: String) -> Result<(), String> {
    // tokio-tungstenite で WSS 接続（api-key ヘッダー付き）
    // 音声データはフロントエンドから invoke('send_audio', { chunk }) で受信
    // テキストデルタは app.emit('transcript-delta', text) でフロントに送信
}
```

これにより Cargo.toml に `tokio-tungstenite`, `tokio` を追加。

---

## ファイル別実装サマリー

| ファイル | 役割 |
|---|---|
| `src-tauri/src/lib.rs` | ホットキー/トレイ/コマンド（paste_text, set_click_through, start_transcription） |
| `src-tauri/tauri.conf.json` | 2ウィンドウ設定、プラグイン有効化 |
| `src-tauri/Cargo.toml` | enigo, windows-sys, tokio-tungstenite 依存 |
| `src/overlay-main.tsx` | オーバーレイ React エントリ |
| `src/Overlay.tsx` | 録音→整形→完了 状態表示UI |
| `src/main.tsx` | 設定画面 React エントリ |
| `src/App.tsx` | 設定フォーム UI |
| `src/transcription.ts` | Realtime API WebSocket（Rust コマンド経由） |
| `src/postprocess.ts` | Chat Completions API（fetch、フロントエンド直接呼び出し） |
| `src/useSettings.ts` | localStorage での設定 CRUD |
| `src/types.ts` | OverlayStatus, AppSettings 型定義 |
| `overlay.html` | オーバーレイウィンドウ HTML |
| `index.html` | 設定ウィンドウ HTML |
| `vite.config.ts` | マルチページ設定（index + overlay） |

---

## 検証手順

1. `npm install` → `cargo build`（依存関係確認）
2. `npm run tauri dev` で開発起動
3. システムトレイにアイコンが出ることを確認
4. 設定画面に Endpoint/APIKey を入力して保存
5. `Ctrl+Shift+Space` を押してオーバーレイが表示されることを確認
6. 話しながら文字起こしテキストがリアルタイム表示されることを確認
7. キーを離して整形→テキストフィールドに貼り付けられることを確認
8. エラー時（マイクなし、API不正）のエラー表示を確認
