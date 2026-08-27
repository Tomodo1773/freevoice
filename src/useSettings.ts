import { useState } from "react";
import { resolveAzureOpenAIBase } from "./azureOpenaiEndpoint";
import { DEFAULT_FORMAT_MODELS } from "./formatProvider";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_POSTPROCESS_PROMPT,
} from "./types";
import { logError } from "./diagLog";

const STORAGE_KEY = "freevoice-settings";

/** localStorage に残りうる旧バージョンのフィールド。 */
interface LegacySettings {
  postprocessModel?: string;
  azureFormatModel?: string;
  openaiFormatModel?: string;
}

function normalizeSettings(raw: Partial<AppSettings> & LegacySettings): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  // ネストしたオブジェクトは spread で共有参照のまま残るため作り直す
  merged.formatModels = { ...DEFAULT_FORMAT_MODELS, ...raw.formatModels };
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
  // マイグレーション: 旧 postprocessModel / azureFormatModel / openaiFormatModel → formatModels
  if (!raw.formatModels) {
    const azure = raw.azureFormatModel ?? raw.postprocessModel;
    if (azure) merged.formatModels.azure = azure;
    if (raw.openaiFormatModel) merged.formatModels.openai = raw.openaiFormatModel;
  }
  // 旧フィールドを除去
  for (const legacy of ["postprocessModel", "azureFormatModel", "openaiFormatModel"]) {
    delete (merged as Record<string, unknown>)[legacy];
  }
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
  // DEFAULT_SETTINGS をそのまま返すと呼び出し側と可変オブジェクトを共有してしまうため、
  // 未保存・読み込み失敗時も normalizeSettings を通す。
  return normalizeSettings({});
}
