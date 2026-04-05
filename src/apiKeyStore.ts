import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "secrets.json";
const API_KEY_KEY = "apiKey";
const FORMAT_API_KEY_KEY = "formatApiKey";
const AZURE_FORMAT_API_KEY_KEY = "azureFormatApiKey";
const OPENAI_FORMAT_API_KEY_KEY = "openaiFormatApiKey";

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
export const getAzureFormatApiKey = () => getValue(AZURE_FORMAT_API_KEY_KEY);
export const setAzureFormatApiKey = (key: string) => setValue(AZURE_FORMAT_API_KEY_KEY, key);
export const getOpenaiFormatApiKey = () => getValue(OPENAI_FORMAT_API_KEY_KEY);
export const setOpenaiFormatApiKey = (key: string) => setValue(OPENAI_FORMAT_API_KEY_KEY, key);

/** マイグレーション: 旧 formatApiKey が存在すれば azureFormatApiKey へ移行 */
export async function migrateFormatApiKey(): Promise<void> {
  const store = await getStore();
  await store.reload();
  const legacy = (await store.get<string>(FORMAT_API_KEY_KEY)) ?? "";
  if (legacy && !(await store.get<string>(AZURE_FORMAT_API_KEY_KEY))) {
    await store.set(AZURE_FORMAT_API_KEY_KEY, legacy);
    await store.delete(FORMAT_API_KEY_KEY);
  }
}

export async function getAllApiKeys(): Promise<{
  apiKey: string;
  azureFormatApiKey: string;
  openaiFormatApiKey: string;
}> {
  const store = await getStore();
  await store.reload();
  return {
    apiKey: (await store.get<string>(API_KEY_KEY)) ?? "",
    azureFormatApiKey: (await store.get<string>(AZURE_FORMAT_API_KEY_KEY)) ?? "",
    openaiFormatApiKey: (await store.get<string>(OPENAI_FORMAT_API_KEY_KEY)) ?? "",
  };
}

