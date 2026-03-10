export type OverlayStatus = "listening" | "transcribing" | "formatting" | "done" | "error";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export type InputMethod = "clipboard" | "keystroke";

export type ApiProvider = "azure" | "openai";

export interface AppSettings {
  shortcut: string;
  provider: ApiProvider;
  endpoint: string;
  transcriptionModel: string;
  postprocessModel: string;
  postprocessPrompt: string;
  logFolder: string;
  reasoningEffort: ReasoningEffort;
  inputMethod: InputMethod;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  provider: "azure",
  endpoint: "",
  transcriptionModel: "gpt-4o-transcribe",
  postprocessModel: "gpt-5.2",
  postprocessPrompt: `ユーザが音声入力した内容を修正して返す。

ユーザが提供するテキストは音声入力で文字起こしされたもので不完全なものである。これに対して以下を行う

1. 音声認識の誤字脱字を文脈から推測して修正する
2. 多すぎる読点、同じ文と思われる箇所に入っている句点の削除など、過剰な句読点を適切に修正する
3. 口語表現の修正をおこなう。例）「〜なんだけど」を「〜なのだが」、「〜してる」を「〜している」など
4. 「えーと」「あのー」「えっと」「まあ」などのフィラーワードを削除する
5. 文脈全体で意味が通るかを確認し、通らない場合は誤った文字起こし結果である可能性も考慮し、適切な単語置換する。
6. 適切な文のまとまりで改行を挿入する。
7. 変換後の内容のみを出力する。

制限事項

- 修整後のテキストのみを出力。余計は前置きは出力しない。
- 口調は従来の口調を維持すること。丁寧な口調であれば丁寧な口調のまま、カジュアルな口調であればカジュアルな口調のまま修正すること。
- 勝手に内容を追加しない。あくまでユーザの発言を修正することに徹すること。
`,
  logFolder: "",
  reasoningEffort: "low",
  inputMethod: "clipboard",
};
