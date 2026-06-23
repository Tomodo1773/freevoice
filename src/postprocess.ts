import OpenAI from "openai";
import { createChatClient, resolveBaseURL } from "./openaiClient";
import { DEFAULT_SETTINGS, FormatProvider, ReasoningEffort } from "./types";
import { logWarn } from "./diagLog";

/** 整形エンドポイントへの接続を録音中に温めておく（TLSハンドシェイクをクリティカルパスから外す）。
 *  接続確立だけが目的なので本文・認証は不要。失敗は無視する。 */
export function warmupFormatConnection(
  formatProvider: FormatProvider,
  endpoint: string,
): void {
  try {
    const origin = new URL(resolveBaseURL(formatProvider, endpoint)).origin;
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
  messages: Array<{ role: string; content: string }>;
}

/** 文脈（話題サマリ）と校正対象を1つの user メッセージにまとめる。
 *  参照情報と校正対象をデリミタで明示し、参照側は出力対象でないと指示する。
 *  user ターンを1つに保つことで「連続 user ＝全部が入力」と誤解され、
 *  文脈まで一緒に整形・出力されるのを防ぐ。 */
export function buildContextualUserMessage(
  context: string,
  transcript: string,
): { role: "user"; content: string } {
  return {
    role: "user",
    content:
      `<参考トピック>\n${context}\n</参考トピック>\n\n` +
      `上記は誤変換補正のヒントであり、出力対象ではない。次の <校正対象> のテキストのみを校正して出力する。\n\n` +
      `<校正対象>\n${transcript}\n</校正対象>`,
  };
}

export function buildPostprocessMessages(
  transcript: string,
  prompt: string,
  context?: string,
): Array<{ role: "system" | "user"; content: string }> {
  const systemPrompt = prompt?.trim() ? prompt : DEFAULT_SETTINGS.postprocessPrompt;
  return [
    { role: "system", content: systemPrompt },
    context?.trim()
      ? buildContextualUserMessage(context, transcript)
      : { role: "user", content: transcript },
  ];
}

export async function postprocess(
  transcript: string,
  formatProvider: FormatProvider,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  reasoningEffort: ReasoningEffort,
  context?: string,
  signal?: AbortSignal,
): Promise<PostprocessResult> {
  if (!transcript.trim()) return { text: transcript, messages: [] };

  const messages = buildPostprocessMessages(transcript, prompt, context);
  const client = createChatClient(formatProvider, endpoint, apiKey);
  const completion = await client.chat.completions.create(
    {
      model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      reasoning_effort: reasoningEffort,
    },
    { signal },
  );

  const text = completion.choices[0]?.message?.content ?? "";
  const promptTokens = completion.usage?.prompt_tokens;
  const completionTokens = completion.usage?.completion_tokens;
  const usage: PostprocessUsage | undefined =
    promptTokens != null && completionTokens != null
      ? { input_tokens: promptTokens, output_tokens: completionTokens }
      : undefined;

  return { text, usage, model: completion.model, messages };
}

const EMPTY_RETRY_DELAYS = [1000, 3000];

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
  context?: string,
  signal?: AbortSignal,
): Promise<PostprocessWithRetryResult> {
  if (!transcript.trim()) return { text: transcript, fallback: false, messages: [] };

  const messages = buildPostprocessMessages(transcript, prompt, context);

  try {
    let result = await postprocess(
      transcript, formatProvider, endpoint, apiKey,
      model, prompt, reasoningEffort, context, signal,
    );

    for (const ms of EMPTY_RETRY_DELAYS) {
      if (result.text.trim()) break;
      logWarn("postprocess", "format api empty response retry", { delay: ms });
      await delay(ms, signal);
      result = await postprocess(
        transcript, formatProvider, endpoint, apiKey,
        model, prompt, reasoningEffort, context, signal,
      );
    }

    if (!result.text.trim()) {
      logWarn("postprocess", "format api fallback", { reason: "空の応答" });
      return { ...result, text: transcript, fallback: true, fallbackReason: "空の応答" };
    }
    return { ...result, fallback: false };
  } catch (e) {
    // AbortError は DOMException として再スローし、Overlay のキャンセル処理に委ねる
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    if (e instanceof OpenAI.APIError) {
      const status = e.status ?? 0;
      const reason =
        status === 401 || status === 403
          ? "認証エラー"
          : status === 404
            ? "エンドポイント不明"
            : status === 429
              ? "レート制限"
              : `エラー ${status}`;
      logWarn("postprocess", "format api fallback", { status, reason });
      return { text: transcript, fallback: true, fallbackReason: reason, errorStatus: status, messages };
    }
    throw e;
  }
}
