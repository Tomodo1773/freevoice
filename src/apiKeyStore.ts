import { load } from "@tauri-apps/plugin-store";
import { FORMAT_PROVIDER_ORDER, FormatProvider, mapFormatProviders } from "./formatProvider";
import { TranscriptionProvider } from "./types";

const STORE_NAME = "secrets.json";
const API_KEY_KEY = "apiKey";
const FORMAT_API_KEY_KEY = "formatApiKey";
const LANGSMITH_API_KEY_KEY = "langsmithApiKey";

/** 整形用 API キーはプロバイダーごとに別レコードで保持する。
 *  キー名は provider ID から導出する（azure → azureFormatApiKey）。 */
const FORMAT_API_KEY_KEYS = mapFormatProviders((_spec, provider) => `${provider}FormatApiKey`);
const TRANSCRIPTION_API_KEY_KEYS: Record<TranscriptionProvider, string> = {
  "azure-openai": "azureOpenAiTranscriptionApiKey",
  "azure-speech": "azureSpeechTranscriptionApiKey",
  "gemini-live": "geminiLiveTranscriptionApiKey",
};
const TRANSCRIPTION_PROVIDERS = Object.keys(TRANSCRIPTION_API_KEY_KEYS) as TranscriptionProvider[];

export type FormatApiKeys = Record<FormatProvider, string>;
export type TranscriptionApiKeys = Record<TranscriptionProvider, string>;

export const emptyFormatApiKeys = (): FormatApiKeys => mapFormatProviders(() => "");
export const emptyTranscriptionApiKeys = (): TranscriptionApiKeys => ({
  "azure-openai": "",
  "azure-speech": "",
  "gemini-live": "",
});

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_NAME, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

async function setValue(key: string, value: string): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
}

export const setLangsmithApiKey = (key: string) => setValue(LANGSMITH_API_KEY_KEY, key);

export async function setTranscriptionApiKeys(keys: TranscriptionApiKeys): Promise<void> {
  for (const provider of TRANSCRIPTION_PROVIDERS) {
    await setValue(TRANSCRIPTION_API_KEY_KEYS[provider], keys[provider]);
  }
}

/** 旧共有キーは、当時選択されていた文字起こしプロバイダーだけへ移す。 */
export async function migrateTranscriptionApiKey(provider: TranscriptionProvider): Promise<void> {
  const store = await getStore();
  await store.reload();
  const legacy = await store.get<string>(API_KEY_KEY);
  if (legacy === undefined || legacy === null) return;
  const target = TRANSCRIPTION_API_KEY_KEYS[provider];
  if (legacy && !(await store.get<string>(target))) await store.set(target, legacy);
  await store.delete(API_KEY_KEY);
}

export async function setFormatApiKeys(keys: FormatApiKeys): Promise<void> {
  for (const provider of FORMAT_PROVIDER_ORDER) {
    await setValue(FORMAT_API_KEY_KEYS[provider], keys[provider]);
  }
}

/** マイグレーション: 旧 formatApiKey が存在すれば azureFormatApiKey へ移行 */
export async function migrateFormatApiKey(): Promise<void> {
  const store = await getStore();
  await store.reload();
  const legacy = (await store.get<string>(FORMAT_API_KEY_KEY)) ?? "";
  if (legacy && !(await store.get<string>(FORMAT_API_KEY_KEYS.azure))) {
    await store.set(FORMAT_API_KEY_KEYS.azure, legacy);
    await store.delete(FORMAT_API_KEY_KEY);
  }
}

export async function getAllApiKeys(): Promise<{
  transcriptionApiKeys: TranscriptionApiKeys;
  formatApiKeys: FormatApiKeys;
  langsmithApiKey: string;
}> {
  const store = await getStore();
  await store.reload();
  const formatApiKeys = emptyFormatApiKeys();
  const transcriptionApiKeys = emptyTranscriptionApiKeys();
  for (const provider of FORMAT_PROVIDER_ORDER) {
    formatApiKeys[provider] = (await store.get<string>(FORMAT_API_KEY_KEYS[provider])) ?? "";
  }
  for (const provider of TRANSCRIPTION_PROVIDERS) {
    transcriptionApiKeys[provider] =
      (await store.get<string>(TRANSCRIPTION_API_KEY_KEYS[provider])) ?? "";
  }
  return {
    transcriptionApiKeys,
    formatApiKeys,
    langsmithApiKey: (await store.get<string>(LANGSMITH_API_KEY_KEY)) ?? "",
  };
}
