import { buildAzureChatCompletionsUrl } from "./azureOpenaiEndpoint";

export async function postprocess(
  transcript: string,
  endpoint: string,
  apiKey: string,
  model: string
): Promise<string> {
  if (!transcript.trim()) return transcript;

  const url = buildAzureChatCompletionsUrl(endpoint, model);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content:
            "あなたは日本語音声認識結果の後処理アシスタントです。\n" +
            "以下のルールに従ってテキストを修正してください:\n" +
            "1. 音声認識の誤字脱字を文脈から推測して修正する\n" +
            "2. 自然な句読点（、。）を適切に挿入する\n" +
            "3. 「えーと」「あのー」「えっと」「まあ」などのフィラーワードを削除する\n" +
            "4. 文章の意味・内容は変えない\n" +
            "5. 修正済みテキストのみを返す（説明や前置きは不要）",
        },
        {
          role: "user",
          content: transcript,
        },
      ],
      reasoning_effort: "none",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`後処理API エラー: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? transcript;
}
