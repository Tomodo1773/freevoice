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

async function getValue(key: string): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(key)) ?? "";
}

async function setValue(key: string, value: string): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
}

export const getApiKey = () => getValue(API_KEY_KEY);
export const setApiKey = (key: string) => setValue(API_KEY_KEY, key);
export const getFormatApiKey = () => getValue(FORMAT_API_KEY_KEY);
export const setFormatApiKey = (key: string) => setValue(FORMAT_API_KEY_KEY, key);

