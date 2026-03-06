export type OverlayStatus = "listening" | "formatting" | "done" | "error";

export interface AppSettings {
  shortcut: string;
  endpoint: string;
  apiKey: string;
  transcriptionModel: string;
  postprocessModel: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  endpoint: "",
  apiKey: "",
  transcriptionModel: "gpt-4o-transcribe",
  postprocessModel: "gpt-5.2",
};
