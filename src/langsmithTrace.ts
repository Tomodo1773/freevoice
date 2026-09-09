import { invoke } from "@tauri-apps/api/core";
import { logWarn } from "./diagLog";
import { ChatMessage } from "./postprocess";
import { LangsmithRegion, ReasoningEffort } from "./types";

const LANGSMITH_ENDPOINTS: Record<LangsmithRegion, string> = {
  us: "https://api.smith.langchain.com/otel/v1/traces",
  eu: "https://eu.api.smith.langchain.com/otel/v1/traces",
};

export function resolveLangsmithEndpoint(region: LangsmithRegion): string {
  return LANGSMITH_ENDPOINTS[region];
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

type AttrValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean };

interface Attribute {
  key: string;
  value: AttrValue;
}

function strAttr(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): Attribute {
  // OTLP/HTTP JSON では int64 は文字列エンコード
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function msToUnixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

export interface LangsmithConfig {
  region: LangsmithRegion;
  project: string;
  apiKey: string;
  includeContent: boolean;
}

export interface LlmSpanParams {
  spanName: string;
  /** gen_ai.system の値。整形は FORMAT_PROVIDERS、文字起こしは TRANSCRIPTION_LANGSMITH_SYSTEMS から取る */
  system: string;
  /** モデル指定の概念を持たないプロバイダー（Azure Speech）では省略する */
  requestModel?: string;
  responseModel?: string;
  messages: ChatMessage[];
  completion?: string;
  /** 文字起こしのように推論設定を持たない呼び出しでは省略する */
  reasoningEffort?: ReasoningEffort;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Date.now() を想定 (ミリ秒) */
  startTimeMs: number;
  endTimeMs: number;
  error?: { message: string; status?: number };
}

interface SpanIds {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/**
 * 1 回の LLM 呼び出しを OTLP/HTTP JSON のスパンに組み立てる。
 * OpenLLMetry の gen_ai.* semantic convention に準拠。
 */
export function buildSpan(
  params: LlmSpanParams,
  ids: SpanIds,
  includeContent: boolean
): object {
  const attributes: Attribute[] = [
    strAttr("langsmith.span.kind", "llm"),
    strAttr("gen_ai.system", params.system),
    strAttr("gen_ai.operation.name", "chat"),
    strAttr("freevoice.operation", params.spanName),
  ];

  if (params.requestModel) {
    attributes.push(strAttr("gen_ai.request.model", params.requestModel));
  }
  if (params.reasoningEffort) {
    attributes.push(strAttr("gen_ai.request.reasoning_effort", params.reasoningEffort));
  }
  if (params.responseModel) {
    attributes.push(strAttr("gen_ai.response.model", params.responseModel));
  }
  if (params.usage?.input_tokens != null) {
    attributes.push(intAttr("gen_ai.usage.input_tokens", params.usage.input_tokens));
  }
  if (params.usage?.output_tokens != null) {
    attributes.push(intAttr("gen_ai.usage.output_tokens", params.usage.output_tokens));
  }

  if (includeContent) {
    params.messages.forEach((msg, idx) => {
      attributes.push(
        strAttr(`gen_ai.prompt.${idx}.role`, msg.role),
        strAttr(`gen_ai.prompt.${idx}.content`, msg.content),
      );
    });
    if (params.completion != null) {
      attributes.push(
        strAttr("gen_ai.completion.0.role", "assistant"),
        strAttr("gen_ai.completion.0.content", params.completion),
      );
    }
  }

  const status = params.error
    ? { code: 2, message: params.error.message }
    : { code: 1 };

  const events = params.error
    ? [
        {
          name: "exception",
          timeUnixNano: msToUnixNano(params.endTimeMs),
          attributes: [
            strAttr(
              "exception.type",
              params.error.status ? `HTTP ${params.error.status}` : "Error"
            ),
            strAttr("exception.message", params.error.message),
          ],
        },
      ]
    : [];

  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(ids.parentSpanId ? { parentSpanId: ids.parentSpanId } : {}),
    name: params.spanName,
    kind: 3, // SPAN_KIND_CLIENT
    startTimeUnixNano: msToUnixNano(params.startTimeMs),
    endTimeUnixNano: msToUnixNano(params.endTimeMs),
    attributes,
    status,
    events,
  };
}

/** 録音1回ぶんを束ねる親スパン。LLM 呼び出しではないので gen_ai.* は持たず、
 *  トレース一覧に出る入出力（文字起こし生テキストと貼り付けたテキスト）だけを載せる。 */
export function buildRootSpan(args: {
  traceId: string;
  spanId: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  input?: string;
  output?: string;
}): object {
  const attributes = [strAttr("langsmith.span.kind", "chain")];
  if (args.input != null) attributes.push(strAttr("input.value", args.input));
  if (args.output != null) attributes.push(strAttr("output.value", args.output));

  return {
    traceId: args.traceId,
    spanId: args.spanId,
    name: args.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: msToUnixNano(args.startTimeMs),
    endTimeUnixNano: msToUnixNano(args.endTimeMs),
    attributes,
    status: { code: 1 },
    events: [],
  };
}

/** スパン群を OTLP/HTTP JSON の resourceSpans 形式に包む。 */
export function buildTracePayload(project: string, spans: object[]): object {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr("service.name", "freevoice"),
            strAttr("langsmith.project", project),
          ],
        },
        scopeSpans: [{ scope: { name: "freevoice" }, spans }],
      },
    ],
  };
}

/** LangSmith へ OTLP ペイロードを送る。失敗はログ出力のみで握り潰し、アプリ本体には影響させない。 */
async function postTrace(config: LangsmithConfig, payload: object): Promise<void> {
  if (!config.apiKey || !config.project) {
    logWarn("langsmith", "trace skipped", { reason: "missing api key or project" });
    return;
  }
  try {
    await invoke("post_langsmith_trace", {
      endpoint: resolveLangsmithEndpoint(config.region),
      apiKey: config.apiKey,
      project: config.project,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    logWarn("langsmith", "trace send failed", { error: e });
  }
}

/**
 * 録音1回ぶんのトレース。子スパンを溜めておき、整形完了時に親スパンごと1回で送る。
 * 送らずに終わった録音（無音・認識エラー・キャンセル）は親が存在しないため、
 * 「親の来ない子は LangSmith 側で破棄される」状況が構造的に発生しない。
 */
export class TraceSession {
  private readonly traceId = randomHex(16);
  private readonly rootSpanId = randomHex(8);
  private readonly spans: object[] = [];

  constructor(
    private readonly config: LangsmithConfig,
    private readonly startTimeMs: number
  ) {}

  addLlmSpan(params: LlmSpanParams): void {
    this.spans.push(
      buildSpan(
        params,
        { traceId: this.traceId, spanId: randomHex(8), parentSpanId: this.rootSpanId },
        this.config.includeContent
      )
    );
  }

  /** input は文字起こしの生テキスト、output は実際に貼り付けたテキスト。 */
  async flush(args: { endTimeMs: number; input: string; output: string }): Promise<void> {
    const root = buildRootSpan({
      traceId: this.traceId,
      spanId: this.rootSpanId,
      name: "recording",
      startTimeMs: this.startTimeMs,
      endTimeMs: args.endTimeMs,
      ...(this.config.includeContent ? { input: args.input, output: args.output } : {}),
    });
    await postTrace(this.config, buildTracePayload(this.config.project, [root, ...this.spans]));
  }
}

export type SendLlmSpanArgs = LlmSpanParams & LangsmithConfig;

/** 単発の LLM 呼び出しを独立したトレースとして送る（話題蒸留のように録音の外で走る処理向け）。 */
export async function sendLlmSpan(args: SendLlmSpanArgs): Promise<void> {
  const span = buildSpan(
    args,
    { traceId: randomHex(16), spanId: randomHex(8) },
    args.includeContent
  );
  await postTrace(args, buildTracePayload(args.project, [span]));
}
