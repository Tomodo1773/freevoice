export type OverlayStatus = "listening" | "transcribing" | "formatting" | "done" | "error";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export type InputMethod = "clipboard" | "keystroke";

export type TranscriptionProvider = "azure-openai" | "azure-speech";

export interface AppSettings {
  shortcut: string;
  endpoint: string;
  transcriptionModel: string;
  postprocessModel: string;
  postprocessPrompt: string;
  logFolder: string;
  reasoningEffort: ReasoningEffort;
  inputMethod: InputMethod;
  transcriptionProvider: TranscriptionProvider;
  speechEndpoint: string;
  speechLanguage: string;
  audioDeviceId: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  endpoint: "",
  transcriptionModel: "gpt-4o-transcribe",
  postprocessModel: "gpt-5.2",
  postprocessPrompt: `ユーザーが提供するテキストは音声入力で文字起こしされたもので、誤った文字起こしの可能性がある。これを以下の手順で修正してユーザーに返す。

1. 音声認識の誤字脱字を文脈から推測して修正する
2. 多すぎる読点、同じ文と思われる箇所に入っている句点の削除など、過剰な句読点を適切に修正する
3. 「えーと」「あのー」「えっと」「まあ」などのフィラーワードを削除する
4. 文脈全体で意味が通るかを確認し、通らない場合は誤った文字起こし結果である可能性も考慮し、適切な単語置換する。
5. 適切な文のまとまりで改行を挿入する。
6. 変換後の内容のみを出力する。

制限事項

- 修整後のテキストのみを出力。余計は前置きは出力しない。
- 口調は従来の口調を維持すること。丁寧な口調であれば丁寧な口調のまま、カジュアルな口調であればカジュアルな口調のまま修正すること。
- 「~して」を「~してください」など勝手な口調の変換は行わない。元の口調を維持すること。
- 勝手に内容を追加しない。あくまでユーザの発言を修正することに徹すること。
`,
  logFolder: "",
  reasoningEffort: "low",
  inputMethod: "clipboard",
  transcriptionProvider: "azure-openai",
  speechEndpoint: "",
  speechLanguage: "ja-JP",
  audioDeviceId: "",
};
