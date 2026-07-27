import { afterEach, describe, expect, it, vi } from "vitest";
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
