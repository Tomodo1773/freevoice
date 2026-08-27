import { buildFormatRequest, ChatMessage, PostprocessError, PostprocessUsage, requestChatCompletion } from "./postprocess";
import { LangsmithConfig, sendLlmSpan } from "./langsmithTrace";
import { FormatProvider } from "./formatProvider";
import { ReasoningEffort } from "./types";
import { logInfo, logWarn } from "./diagLog";

/** ウィンドウ（hwnd）ごとの話題コンテキスト。
 *  key は hwnd 文字列。同一アプリの別ウィンドウも一意に区別できる安定キー。 */
interface WindowContextEntry {
  summary: string;
  updatedAt: number;
  exe: string;
  title: string;
}

/** TTL を超えたコンテキストは話題が変わった/hwnd 再利用とみなして破棄する。 */
const TTL_MS = 30 * 60 * 1000;
/** メモリ上限。超過時は最も古い（最終更新が古い）エントリから evict。 */
const MAX_ENTRIES = 20;

const store = new Map<string, WindowContextEntry>();
const inFlight = new Set<string>();

/** id（hwnd）に対応する話題サマリを返す。未登録または TTL 超過なら破棄して null。 */
export function getContext(id: string): string | null {
  if (!id) return null;
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return entry.summary;
}

/** サマリを更新する。Map の挿入順を使った LRU で、上限超過時は最古を evict。 */
export function updateContext(id: string, exe: string, title: string, summary: string): void {
  if (!id || !summary.trim()) return;
  // 既存削除→再挿入で末尾（最新）に移動させる
  store.delete(id);
  store.set(id, { summary: summary.trim(), updatedAt: Date.now(), exe, title });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 同一 id の処理多重起動を防ぐ。実行中なら何もせず false を返す。 */
export async function withInFlightGuard(
  id: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (!id || inFlight.has(id)) return false;
  inFlight.add(id);
  try {
    await fn();
  } finally {
    inFlight.delete(id);
  }
  return true;
}

export interface DistillConfig {
  formatProvider: FormatProvider;
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

const DISTILL_SYSTEM_PROMPT = `あなたは音声入力の誤変換補正に使う「話題メモ」を管理する。
旧メモと新しい発話から、メモを毎回ゼロから書き直す（追記ではない）。

目的: 後続の音声文字起こしで同音異義語・専門用語の誤変換を防ぐヒントを提供する。

ルール:
- 現在の話題を1〜2文でまとめる。3文以上は禁止
- 話題が変わったら旧メモの内容は捨てる。履歴を残さない
- 誤変換補正に役立つ固有名詞・専門用語は正確な表記で保持する
- 経緯・詳細・結論は不要。「何の領域の話か」だけ書く
- メモ本文のみ出力する`;

/** 蒸留呼び出しのタイムアウト。接続スタール時に in-flight ガードが固着しないよう必ず中断する。 */
const DISTILL_TIMEOUT_MS = 15000;

export function buildDistillMessages(prev: string, formatted: string): ChatMessage[] {
  return [
    { role: "system", content: DISTILL_SYSTEM_PROMPT },
    {
      role: "user",
      content: `これまでの話題メモ:\n${prev || "（なし）"}\n\n新しい発話:\n${formatted}`,
    },
  ];
}

export interface DistillResult {
  summary: string;
  usage?: PostprocessUsage;
  model?: string;
  messages: ChatMessage[];
}

/** 旧サマリと新しい整形済みテキストから、更新された話題サマリを生成する。 */
export async function distillTopic(
  prev: string,
  formatted: string,
  config: DistillConfig,
): Promise<DistillResult> {
  const messages = buildDistillMessages(prev, formatted);
  const { url, headers } = buildFormatRequest(config.formatProvider, config.endpoint, config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISTILL_TIMEOUT_MS);
  try {
    const { content, usage, model } = await requestChatCompletion(
      url,
      headers,
      {
        model: config.model,
        messages,
        reasoning_effort: config.reasoningEffort,
      },
      controller.signal
    );
    return { summary: content.trim(), usage, model, messages };
  } finally {
    clearTimeout(timer);
  }
}

/** paste 後に非同期で呼ぶ。旧サマリ＋整形済みテキストを蒸留して該当ウィンドウのサマリを更新する。
 *  同一ウィンドウの多重起動はスキップ。失敗は診断ログのみで握り潰す。 */
export async function refreshContext(
  id: string,
  exe: string,
  title: string,
  formatted: string,
  config: DistillConfig,
  langsmith?: LangsmithConfig,
): Promise<void> {
  await withInFlightGuard(id, async () => {
    const prev = store.get(id)?.summary ?? "";
    const startTimeMs = Date.now();
    let result: DistillResult | undefined;
    let distillError: { message: string; status?: number } | undefined;

    try {
      result = await distillTopic(prev, formatted, config);
      updateContext(id, exe, title, result.summary);
      logInfo("windowContext", "topic distilled", { id, exe, summaryLength: result.summary.length });
    } catch (e) {
      distillError = e instanceof PostprocessError
        ? { message: e.message, status: e.status }
        : { message: e instanceof Error ? e.message : String(e) };
      logWarn("windowContext", "distill failed", { error: e });
    }

    if (langsmith) {
      void sendLlmSpan({
        spanName: "distill",
        region: langsmith.region,
        project: langsmith.project,
        apiKey: langsmith.apiKey,
        provider: config.formatProvider,
        requestModel: config.model,
        responseModel: result?.model,
        messages: result?.messages ?? buildDistillMessages(prev, formatted),
        completion: result?.summary,
        reasoningEffort: config.reasoningEffort,
        usage: result?.usage,
        startTimeMs,
        endTimeMs: Date.now(),
        includeContent: langsmith.includeContent,
        error: distillError,
      });
    }
  });
}

/** テスト用: ストアと in-flight 状態をクリアする。 */
export function _resetForTest(): void {
  store.clear();
  inFlight.clear();
}
