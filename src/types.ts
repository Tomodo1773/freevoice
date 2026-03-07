export type OverlayStatus = "listening" | "formatting" | "done" | "error";

export interface AppSettings {
  shortcut: string;
  endpoint: string;
  apiKey: string;
  transcriptionModel: string;
  postprocessModel: string;
  postprocessPrompt: string;
  logFolder: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  endpoint: "",
  apiKey: "",
  transcriptionModel: "gpt-4o-transcribe",
  postprocessModel: "gpt-5.2",
  postprocessPrompt: `あなたは日本語音声認識結果の後処理アシスタントです。
以下のルールに従ってテキストを修正してください:
1. 音声認識の誤字脱字を文脈から推測して修正する
2. 自然な句読点（、。）を適切に挿入する
3. 「えーと」「あのー」「えっと」「まあ」などのフィラーワードを削除する
4. 文章の意味・内容は変えない
5. 修正済みテキストのみを返す（説明や前置きは不要）`,
  logFolder: "",
};
