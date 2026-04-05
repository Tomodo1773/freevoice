import { DEFAULT_SETTINGS, FormatProvider, ReasoningEffort } from "./types";

export class PostprocessError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "PostprocessError";
  }

  get retryable(): boolean {
    return [429, 500, 502, 503].includes(this.status);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function buildFormatRequest(
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const base = endpoint.replace(/\/+$/, "");
  const url = formatProvider === "azure"
    ? `${base}/openai/v1/chat/completions`
    : `${base}/chat/completions`;
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      ...(formatProvider === "openai"
        ? { Authorization: `Bearer ${apiKey}` }
        : { "api-key": apiKey }),
    },
  };
}

export async function postprocess(
  transcript: string,
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  reasoningEffort: ReasoningEffort,
  signal?: AbortSignal
): Promise<string> {
  if (!transcript.trim()) return transcript;
  const systemPrompt = prompt?.trim() ? prompt : DEFAULT_SETTINGS.postprocessPrompt;

  const { url, headers } = buildFormatRequest(formatProvider, endpoint, apiKey);

  const res = await fetch(url, {
    method: "POST",
    headers,
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
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new PostprocessError(`後処理API エラー: ${res.status} ${text}`, res.status, text);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? transcript;
}

const RETRY_DELAYS = [1000, 3000];

export async function postprocessWithRetry(
  transcript: string,
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  reasoningEffort: ReasoningEffort,
  signal?: AbortSignal
): Promise<{ text: string; fallback: boolean }> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const text = await postprocess(transcript, formatProvider, endpoint, apiKey, model, prompt, reasoningEffort, signal);
      return { text, fallback: false };
    } catch (e) {
      if (!(e instanceof PostprocessError)) throw e;
      if (!e.retryable || attempt >= RETRY_DELAYS.length) {
        console.warn(`[FreeVoice] フォーマットAPI フォールバック: ${e.message}`);
        return { text: transcript, fallback: true };
      }
      console.warn(`[FreeVoice] フォーマットAPI リトライ ${attempt + 1}/${RETRY_DELAYS.length}: ${e.status}`);
      await delay(RETRY_DELAYS[attempt], signal);
    }
  }
  /* istanbul ignore next -- unreachable: loop always returns */
  return { text: transcript, fallback: true };
}
