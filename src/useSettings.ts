import { useState } from "react";
import { AppSettings, DEFAULT_SETTINGS } from "./types";

const STORAGE_KEY = "freevoice-settings";

function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  if (!merged.postprocessPrompt?.trim()) {
    merged.postprocessPrompt = DEFAULT_SETTINGS.postprocessPrompt;
  }
  return merged;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return normalizeSettings(JSON.parse(stored) as Partial<AppSettings>);
      }
    } catch {
      // ignore
    }
    return DEFAULT_SETTINGS;
  });

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
