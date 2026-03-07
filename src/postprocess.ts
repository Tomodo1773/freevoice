import { buildAzureChatCompletionsUrl } from "./azureOpenaiEndpoint";
import { DEFAULT_SETTINGS } from "./types";

export async function postprocess(
  transcript: string,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  if (!transcript.trim()) return transcript;
  const systemPrompt = prompt?.trim() ? prompt : DEFAULT_SETTINGS.postprocessPrompt;

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
          content: systemPrompt,
        },
        {
          role: "user",
          content: transcript,
        },
      ],
      reasoning_effort: "medium",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`後処理API エラー: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? transcript;
}
