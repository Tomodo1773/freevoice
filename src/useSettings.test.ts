import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FORMAT_MODELS } from "./formatProvider";
import {
  DEFAULT_POSTPROCESS_PROMPT,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_POSTPROCESS_PROMPT,
} from "./types";
import { loadSettings } from "./useSettings";

const STORAGE_KEY = "freevoice-settings";

function stubLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => void values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("loadSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("保存済みの旧デフォルトプロンプトを新しい内容へ移行する", () => {
    const storage = stubLocalStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        postprocessPrompt: LEGACY_DEFAULT_POSTPROCESS_PROMPT,
      }),
    );

    expect(loadSettings().postprocessPrompt).toBe(DEFAULT_POSTPROCESS_PROMPT);
  });

  it("旧 azureFormatModel / openaiFormatModel を formatModels へ移行する", () => {
    const storage = stubLocalStorage();
    const { formatModels: _omit, ...rest } = DEFAULT_SETTINGS;
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...rest,
        azureFormatModel: "my-azure-deployment",
        openaiFormatModel: "gpt-4o",
      }),
    );

    const loaded = loadSettings();
    expect(loaded.formatModels.azure).toBe("my-azure-deployment");
    expect(loaded.formatModels.openai).toBe("gpt-4o");
    // 未設定だった Gemini はデフォルトモデルで埋まる
    expect(loaded.formatModels.gemini).toBe(DEFAULT_FORMAT_MODELS.gemini);
    expect(loaded).not.toHaveProperty("azureFormatModel");
    expect(loaded).not.toHaveProperty("openaiFormatModel");
  });

  it("さらに古い postprocessModel は formatModels.azure へ移行する", () => {
    const storage = stubLocalStorage();
    const { formatModels: _omit, ...rest } = DEFAULT_SETTINGS;
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...rest, postprocessModel: "legacy-deployment" }),
    );

    expect(loadSettings().formatModels.azure).toBe("legacy-deployment");
  });

  it("プロバイダーごとのモデルをそれぞれ保持する", () => {
    const storage = stubLocalStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        formatModels: { azure: "a", openai: "o", gemini: "g" },
      }),
    );

    expect(loadSettings().formatModels).toEqual({ azure: "a", openai: "o", gemini: "g" });
  });

  it("未保存でもデフォルトを返し、DEFAULT_SETTINGS と可変オブジェクトを共有しない", () => {
    stubLocalStorage();

    const loaded = loadSettings();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(loaded.formatModels).not.toBe(DEFAULT_SETTINGS.formatModels);
  });

  it("ユーザーが編集したプロンプトは維持する", () => {
    const storage = stubLocalStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        postprocessPrompt: "私専用の編集ルール",
      }),
    );

    expect(loadSettings().postprocessPrompt).toBe("私専用の編集ルール");
  });
});
