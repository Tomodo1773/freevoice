import { buildChatCompletionsUrl, buildAuthHeaders } from "./apiEndpoint";
import { ApiProvider, DEFAULT_SETTINGS, ReasoningEffort } from "./types";

export async function postprocess(
  transcript: string,
  provider: ApiProvider,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  reasoningEffort: ReasoningEffort
): Promise<string> {
  if (!transcript.trim()) return transcript;
  const systemPrompt = prompt?.trim() ? prompt : DEFAULT_SETTINGS.postprocessPrompt;

  const url = buildChatCompletionsUrl(provider, endpoint);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(provider, apiKey),
    },
    body: JSON.stringify({
      model,
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
      reasoning_effort: reasoningEffort,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`後処理API エラー: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? transcript;
}
