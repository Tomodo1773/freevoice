import { invoke } from "@tauri-apps/api/core";
import { logWarn } from "./diagLog";
import { ChatMessage } from "./postprocess";
import { FORMAT_PROVIDERS, FormatProvider } from "./formatProvider";
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
  provider: FormatProvider;
  requestModel: string;
  responseModel?: string;
  messages: ChatMessage[];
  completion?: string;
  reasoningEffort: ReasoningEffort;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Date.now() を想定 (ミリ秒) */
  startTimeMs: number;
  endTimeMs: number;
  includeContent: boolean;
  error?: { message: string; status?: number };
}

/**
 * 1 回の LLM 呼び出しを OTLP/HTTP JSON の resourceSpans 形式で組み立てる。
 * OpenLLMetry の gen_ai.* semantic convention に準拠。
 */
export function buildLlmSpanPayload(
  params: LlmSpanParams,
  project: string
): object {
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  const system = FORMAT_PROVIDERS[params.provider].langsmithSystem;

  const attributes: Attribute[] = [
    strAttr("gen_ai.system", system),
    strAttr("gen_ai.operation.name", "chat"),
    strAttr("gen_ai.request.model", params.requestModel),
    strAttr("gen_ai.request.reasoning_effort", params.reasoningEffort),
    strAttr("freevoice.operation", params.spanName),
  ];

  if (params.responseModel) {
    attributes.push(strAttr("gen_ai.response.model", params.responseModel));
  }
  if (params.usage?.input_tokens != null) {
    attributes.push(intAttr("gen_ai.usage.input_tokens", params.usage.input_tokens));
  }
  if (params.usage?.output_tokens != null) {
    attributes.push(intAttr("gen_ai.usage.output_tokens", params.usage.output_tokens));
  }

  if (params.includeContent) {
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
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr("service.name", "freevoice"),
            strAttr("langsmith.project", project),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "freevoice" },
            spans: [
              {
                traceId,
                spanId,
                name: params.spanName,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: msToUnixNano(params.startTimeMs),
                endTimeUnixNano: msToUnixNano(params.endTimeMs),
                attributes,
                status,
                events,
              },
            ],
          },
        ],
      },
    ],
  };
}

export type SendLlmSpanArgs = LlmSpanParams & LangsmithConfig;

/**
 * LangSmith に LLM 呼び出しのトレースを送信する。
 * 失敗はログ出力のみで握り潰し、アプリ本体の動作には影響させない。
 */
export async function sendLlmSpan(args: SendLlmSpanArgs): Promise<void> {
  if (!args.apiKey || !args.project) {
    logWarn("langsmith", "trace skipped", { reason: "missing api key or project" });
    return;
  }
  try {
    const endpoint = resolveLangsmithEndpoint(args.region);
    const body = JSON.stringify(buildLlmSpanPayload(args, args.project));
    await invoke("post_langsmith_trace", {
      endpoint,
      apiKey: args.apiKey,
      project: args.project,
      body,
    });
  } catch (e) {
    logWarn("langsmith", "trace send failed", { error: e });
  }
}
