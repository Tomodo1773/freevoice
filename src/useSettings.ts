import { useState } from "react";
import { resolveAzureOpenAIBase } from "./azureOpenaiEndpoint";
import { AppSettings, DEFAULT_SETTINGS } from "./types";

const STORAGE_KEY = "freevoice-settings";

function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  if (!merged.postprocessPrompt?.trim()) {
    merged.postprocessPrompt = DEFAULT_SETTINGS.postprocessPrompt;
  }
  // マイグレーション: 既存ユーザーの共用endpointからformatEndpointを導出
  if (!merged.formatEndpoint?.trim() && merged.endpoint?.trim()) {
    try {
      merged.formatEndpoint = resolveAzureOpenAIBase(merged.endpoint) + "/openai/v1";
    } catch {
      // ignore
    }
  }
  return merged;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const saveSettings = (next: AppSettings) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}
