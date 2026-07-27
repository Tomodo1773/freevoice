import { useState } from "react";
import { resolveAzureOpenAIBase } from "./azureOpenaiEndpoint";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_POSTPROCESS_PROMPT,
} from "./types";
import { logError } from "./diagLog";

const STORAGE_KEY = "freevoice-settings";

function normalizeSettings(raw: Partial<AppSettings> & { postprocessModel?: string }): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  if (!merged.postprocessPrompt?.trim()) {
    merged.postprocessPrompt = DEFAULT_SETTINGS.postprocessPrompt;
  } else if (merged.postprocessPrompt === LEGACY_DEFAULT_POSTPROCESS_PROMPT) {
    // ユーザーが編集していない旧デフォルトだけを新しい内容へ更新する。
    merged.postprocessPrompt = DEFAULT_SETTINGS.postprocessPrompt;
  }
  // マイグレーション: 既存ユーザーの共用endpointからformatEndpointを導出
  if (!merged.formatEndpoint?.trim() && merged.endpoint?.trim()) {
    try {
      merged.formatEndpoint = resolveAzureOpenAIBase(merged.endpoint);
    } catch {
      // ignore
    }
  }
  // マイグレーション: 旧 postprocessModel → azureFormatModel
  if (raw.postprocessModel && !raw.azureFormatModel) {
    merged.azureFormatModel = raw.postprocessModel;
  }
  // 旧フィールドを除去
  delete (merged as Record<string, unknown>).postprocessModel;
  return merged;
}

/** localStorage への書き込みのみ行う純粋関数。
 *  Overlay ウィンドウ等、React フック外からも設定を永続化する必要がある場合に使う。 */
export function persistSettings(next: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const saveSettings = (next: AppSettings) => {
    persistSettings(next);
    setSettings(next);
  };

  return { settings, saveSettings };
}

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return normalizeSettings(JSON.parse(stored) as Partial<AppSettings>);
    }
  } catch (e) {
    // 設定の読み込み失敗はデフォルトに戻る＝ユーザーには「設定が消えた」ように見える。
    // 原因（破損した localStorage 等）を必ず残す。
    logError("useSettings.loadSettings", "failed to load settings, using defaults", e);
  }
  return DEFAULT_SETTINGS;
}
