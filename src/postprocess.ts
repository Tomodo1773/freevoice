import { DEFAULT_SETTINGS, FormatProvider, ReasoningEffort } from "./types";
import { logWarn } from "./diagLog";

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
  const base = formatProvider === "openai"
    ? "https://api.openai.com/v1"
    : endpoint.replace(/\/+$/, "");
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

export interface PostprocessUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface PostprocessResult {
  text: string;
  usage?: PostprocessUsage;
  model?: string;
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
): Promise<PostprocessResult> {
  if (!transcript.trim()) return { text: transcript };
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
  const text: string = data.choices?.[0]?.message?.content ?? transcript;
  const promptTokens = data.usage?.prompt_tokens;
  const completionTokens = data.usage?.completion_tokens;
  const usage: PostprocessUsage | undefined =
    typeof promptTokens === "number" && typeof completionTokens === "number"
      ? { input_tokens: promptTokens, output_tokens: completionTokens }
      : undefined;
  const responseModel: string | undefined =
    typeof data.model === "string" ? data.model : undefined;
  return { text, usage, model: responseModel };
}

const RETRY_DELAYS = [1000, 3000];

export interface PostprocessWithRetryResult extends PostprocessResult {
  fallback: boolean;
  fallbackReason?: string;
  errorStatus?: number;
}

export async function postprocessWithRetry(
  transcript: string,
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  reasoningEffort: ReasoningEffort,
  signal?: AbortSignal
): Promise<PostprocessWithRetryResult> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const result = await postprocess(transcript, formatProvider, endpoint, apiKey, model, prompt, reasoningEffort, signal);
      return { ...result, fallback: false, fallbackReason: undefined };
    } catch (e) {
      if (!(e instanceof PostprocessError)) throw e;
      if (!e.retryable || attempt >= RETRY_DELAYS.length) {
        const reason = e.status === 401 || e.status === 403
          ? "認証エラー"
          : e.status === 404
          ? "エンドポイント不明"
          : e.status === 429
          ? "レート制限"
          : `エラー ${e.status}`;
        logWarn("postprocess", "format api fallback", { status: e.status, reason });
        return { text: transcript, fallback: true, fallbackReason: reason, errorStatus: e.status };
      }
      logWarn("postprocess", "format api retry", {
        attempt: attempt + 1,
        max: RETRY_DELAYS.length,
        status: e.status,
      });
      await delay(RETRY_DELAYS[attempt], signal);
    }
  }
  /* istanbul ignore next -- unreachable: loop always returns */
  return { text: transcript, fallback: true, fallbackReason: undefined };
}
