import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      reload: vi.fn(async () => {}),
      get: vi.fn(async (key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: string) => void values.set(key, value)),
      delete: vi.fn(async (key: string) => void values.delete(key)),
    },
  };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => fake.store),
}));

import {
  emptyTranscriptionApiKeys,
  getAllApiKeys,
  migrateTranscriptionApiKey,
  setTranscriptionApiKeys,
} from "./apiKeyStore";

describe("transcription API key store", () => {
  beforeEach(() => {
    fake.values.clear();
    vi.clearAllMocks();
  });

  it("旧共有キーを選択中プロバイダーだけへ移す", async () => {
    fake.values.set("apiKey", "legacy-key");

    await migrateTranscriptionApiKey("azure-speech");
    const { transcriptionApiKeys } = await getAllApiKeys();

    expect(transcriptionApiKeys).toEqual({
      "azure-openai": "",
      "azure-speech": "legacy-key",
      "gemini-live": "",
    });
    expect(fake.values.has("apiKey")).toBe(false);
  });

  it("AzureとGeminiのキーを別々に保持する", async () => {
    const keys = emptyTranscriptionApiKeys();
    keys["azure-speech"] = "azure-key";
    keys["gemini-live"] = "gemini-key";
    await setTranscriptionApiKeys(keys);

    const { transcriptionApiKeys } = await getAllApiKeys();
    expect(transcriptionApiKeys["azure-speech"]).toBe("azure-key");
    expect(transcriptionApiKeys["gemini-live"]).toBe("gemini-key");
  });
});
