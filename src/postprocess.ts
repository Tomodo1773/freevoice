import { DEFAULT_SETTINGS, FormatProvider, ReasoningEffort } from "./types";
import { logWarn } from "./diagLog";

export class PostprocessError extends Error {
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string,
    retryable?: boolean,
  ) {
    super(message);
    this.name = "PostprocessError";
    this.retryable = retryable ?? [429, 500, 502, 503].includes(status);
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

export function buildFormatUrl(
  formatProvider: FormatProvider,
  endpoint: string,
): string {
  const base = formatProvider === "openai"
    ? "https://api.openai.com/v1"
    : endpoint.replace(/\/+$/, "");
  return formatProvider === "azure"
    ? `${base}/openai/v1/chat/completions`
    : `${base}/chat/completions`;
}

export function buildFormatRequest(
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  return {
    url: buildFormatUrl(formatProvider, endpoint),
    headers: {
      "Content-Type": "application/json",
      ...(formatProvider === "openai"
        ? { Authorization: `Bearer ${apiKey}` }
        : { "api-key": apiKey }),
    },
  };
}

/** 整形エンドポイントへの接続を録音中に温めておく（TLSハンドシェイクをクリティカルパスから外す）。
 *  接続確立だけが目的なので本文・認証は不要。失敗は無視する。 */
export function warmupFormatConnection(
  formatProvider: FormatProvider,
  endpoint: string,
): void {
  try {
    const origin = new URL(buildFormatUrl(formatProvider, endpoint)).origin;
    void fetch(origin, { method: "HEAD", mode: "no-cors" }).catch(() => {});
  } catch {
    // endpoint未設定など。ウォームアップ失敗は本処理に影響させない
  }
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
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new PostprocessError("後処理API 空の応答", res.status, "", true);
  }
  const text: string = content;
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
        const reason = e.status < 400
          ? "空の応答"
          : e.status === 401 || e.status === 403
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
