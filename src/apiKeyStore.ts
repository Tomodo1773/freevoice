import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "secrets.json";
const API_KEY_KEY = "apiKey";
const FORMAT_API_KEY_KEY = "formatApiKey";

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_NAME, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

export async function getApiKey(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(API_KEY_KEY)) ?? "";
}

export async function setApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(API_KEY_KEY, key);
}

export async function getFormatApiKey(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(FORMAT_API_KEY_KEY)) ?? "";
}

export async function setFormatApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(FORMAT_API_KEY_KEY, key);
}

