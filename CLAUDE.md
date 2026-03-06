# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## アプリ概要

FreeVoice は Windows 専用の音声入力ツール。`Ctrl+Shift+Space` を押している間だけ録音し（Push-to-Talk）、離すと AI で後処理して現在フォーカス中のテキストフィールドに貼り付ける個人利用専用アプリ。

## コマンド

```bash
# 開発サーバー起動（フロントエンド + Tauri）
npm run tauri dev

# プロダクションビルド
npm run tauri build

# フロントエンドのみビルド
npm run build

# 型チェック
npx tsc --noEmit
```

## アーキテクチャ

### 2ウィンドウ構成

| ウィンドウ | label | エントリポイント | 役割 |
|-----------|-------|----------------|------|
| 設定画面 | `main` | `index.html` → `src/main.tsx` → `App.tsx` | 初期非表示。トレイから開く |
| オーバーレイ | `overlay` | `overlay.html` → `src/overlay-main.tsx` → `Overlay.tsx` | 初期非表示。録音中のみ表示。クリック透過・常前面 |

### フロントエンド / Rust の責務分担

ロジックは可能な限り全てフロントエンドに、Rust で書く内容は最小限にする。