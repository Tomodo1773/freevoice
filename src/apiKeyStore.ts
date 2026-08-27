import { load } from "@tauri-apps/plugin-store";
import { FORMAT_PROVIDER_ORDER, FormatProvider, mapFormatProviders } from "./formatProvider";

const STORE_NAME = "secrets.json";
const API_KEY_KEY = "apiKey";
const FORMAT_API_KEY_KEY = "formatApiKey";
const LANGSMITH_API_KEY_KEY = "langsmithApiKey";

/** 整形用 API キーはプロバイダーごとに別レコードで保持する。
 *  キー名は provider ID から導出する（azure → azureFormatApiKey）。 */
const FORMAT_API_KEY_KEYS = mapFormatProviders((_spec, provider) => `${provider}FormatApiKey`);

export type FormatApiKeys = Record<FormatProvider, string>;

export const emptyFormatApiKeys = (): FormatApiKeys => mapFormatProviders(() => "");

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_NAME, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

async function getValue(key: string): Promise<string> {
  const store = await getStore();
  // 別ウィンドウからの書き込みを反映するためディスクから再読み込み
  await store.reload();
  return (await store.get<string>(key)) ?? "";
}

async function setValue(key: string, value: string): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
}

export const getApiKey = () => getValue(API_KEY_KEY);
export const setApiKey = (key: string) => setValue(API_KEY_KEY, key);
export const getLangsmithApiKey = () => getValue(LANGSMITH_API_KEY_KEY);
export const setLangsmithApiKey = (key: string) => setValue(LANGSMITH_API_KEY_KEY, key);

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
  apiKey: string;
  formatApiKeys: FormatApiKeys;
  langsmithApiKey: string;
}> {
  const store = await getStore();
  await store.reload();
  const formatApiKeys = emptyFormatApiKeys();
  for (const provider of FORMAT_PROVIDER_ORDER) {
    formatApiKeys[provider] = (await store.get<string>(FORMAT_API_KEY_KEYS[provider])) ?? "";
  }
  return {
    apiKey: (await store.get<string>(API_KEY_KEY)) ?? "",
    formatApiKeys,
    langsmithApiKey: (await store.get<string>(LANGSMITH_API_KEY_KEY)) ?? "",
  };
}
