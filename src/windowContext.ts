import { buildFormatRequest } from "./postprocess";
import { FormatProvider, ReasoningEffort } from "./types";
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

const DISTILL_SYSTEM_PROMPT = `あなたは音声入力アシスタントの文脈管理器です。
これまでの「話題メモ」と新しい発話（整形済みテキスト）を受け取り、話題メモを更新してください。
このメモは後続の文字起こし整形で、ドメインを手がかりに同音異義の誤変換を補正するために使われます。

出力要件:
- 扱っているドメイン・技術・話題を2〜3行で簡潔にまとめる
- 固有名詞・専門用語は正しい表記のまま保持する
- 個々の単語の羅列ではなく「何について話しているか」を抽象化する
- 古くなって無関係になった話題は落とす
- 前置きや説明を書かず、メモ本文のみを出力する`;

/** 旧サマリと新しい整形済みテキストから、更新された話題サマリを生成する。 */
export async function distillTopic(
  prev: string,
  formatted: string,
  config: DistillConfig,
): Promise<string> {
  const { url, headers } = buildFormatRequest(config.formatProvider, config.endpoint, config.apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: DISTILL_SYSTEM_PROMPT },
        {
          role: "user",
          content: `これまでの話題メモ:\n${prev || "（なし）"}\n\n新しい発話:\n${formatted}`,
        },
      ],
      reasoning_effort: config.reasoningEffort,
    }),
  });
  if (!res.ok) {
    throw new Error(`蒸留API エラー: ${res.status}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("蒸留API 空の応答");
  }
  return content.trim();
}

/** paste 後に非同期で呼ぶ。旧サマリ＋整形済みテキストを蒸留して該当ウィンドウのサマリを更新する。
 *  同一ウィンドウの多重起動はスキップ。失敗は診断ログのみで握り潰す。 */
export async function refreshContext(
  id: string,
  exe: string,
  title: string,
  formatted: string,
  config: DistillConfig,
): Promise<void> {
  await withInFlightGuard(id, async () => {
    try {
      const prev = store.get(id)?.summary ?? "";
      const summary = await distillTopic(prev, formatted, config);
      updateContext(id, exe, title, summary);
      logInfo("windowContext", "topic distilled", { id, exe, summary });
    } catch (e) {
      logWarn("windowContext", "distill failed", { error: e });
    }
  });
}

/** テスト用: ストアと in-flight 状態をクリアする。 */
export function _resetForTest(): void {
  store.clear();
  inFlight.clear();
}
