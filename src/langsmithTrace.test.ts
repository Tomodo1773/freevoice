import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildSpan, LlmSpanParams, TraceSession } from "./langsmithTrace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: { key: string; value: { stringValue?: string } }[];
}

function spansOf(payload: object): Span[] {
  return (payload as any).resourceSpans[0].scopeSpans[0].spans;
}

function findStr(span: Span, key: string): string | undefined {
  return span.attributes.find((a) => a.key === key)?.value?.stringValue;
}

function only(params: LlmSpanParams, includeContent = true): Span {
  return buildSpan(params, { traceId: "t".repeat(32), spanId: "s".repeat(16) }, includeContent) as Span;
}

const base: LlmSpanParams = {
  spanName: "format",
  system: "openai",
  requestModel: "gpt-4o",
  messages: [
    { role: "system", content: "SYS" },
    { role: "user", content: "TR" },
  ],
  reasoningEffort: "low",
  startTimeMs: 0,
  endTimeMs: 1,
};

describe("buildSpan", () => {
  it("spanName がスパン名と freevoice.operation 属性に反映される", () => {
    const p = only(base);
    expect(p.name).toBe("format");
    expect(findStr(p, "freevoice.operation")).toBe("format");

    const d = only({ ...base, spanName: "distill" });
    expect(d.name).toBe("distill");
    expect(findStr(d, "freevoice.operation")).toBe("distill");
  });

  it("文脈なし: prompt.0=system, prompt.1=user, prompt.2は無し", () => {
    const p = only(base);
    expect(findStr(p, "gen_ai.prompt.0.role")).toBe("system");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("文脈あり: messages配列がそのまま反映される", () => {
    const p = only({
      ...base,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "<参考トピック>\nCTX\n</参考トピック>\n\nTR" },
      ],
    });
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toContain("CTX");
    expect(findStr(p, "gen_ai.prompt.1.content")).toContain("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("includeContent=false ではプロンプト内容を含めない", () => {
    const p = only(base, false);
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(findStr(p, "gen_ai.prompt.1.content")).toBeUndefined();
  });

  it("空の messages ではプロンプト内容を含めない", () => {
    const p = only({ ...base, messages: [] });
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
  });

  it("文字起こしのように model/reasoningEffort を持たない呼び出しでは属性を出さない", () => {
    const p = only({
      spanName: "transcribe",
      system: "gcp.gemini",
      messages: [{ role: "user", content: "audio_segment" }],
      completion: "こんにちは",
      startTimeMs: 0,
      endTimeMs: 1,
    });
    expect(findStr(p, "gen_ai.request.model")).toBeUndefined();
    expect(findStr(p, "gen_ai.request.reasoning_effort")).toBeUndefined();
    expect(findStr(p, "gen_ai.completion.0.content")).toBe("こんにちは");
  });
});

describe("TraceSession", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  const config = { region: "us", project: "proj", apiKey: "k", includeContent: true } as const;

  function flushedSpans(): Span[] {
    const args = vi.mocked(invoke).mock.calls[0][1] as { body: string };
    return spansOf(JSON.parse(args.body));
  }

  it("追加したスパンが root の子として同一トレースにまとまる", async () => {
    const trace = new TraceSession(config, 0);
    trace.addLlmSpan({ ...base, spanName: "transcribe" });
    trace.addLlmSpan(base);
    await trace.flush(100);

    const spans = flushedSpans();
    expect(spans.map((s) => s.name)).toEqual(["recording", "transcribe", "format"]);

    const [root, ...children] = spans;
    expect(root.parentSpanId).toBeUndefined();
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    for (const child of children) {
      expect(child.parentSpanId).toBe(root.spanId);
    }
    expect(new Set(children.map((s) => s.spanId)).size).toBe(children.length);
  });

  it("root スパンは chain 種別で gen_ai.* を持たない", async () => {
    const trace = new TraceSession(config, 0);
    trace.addLlmSpan(base);
    await trace.flush(100);

    const root = flushedSpans()[0];
    expect(findStr(root, "langsmith.span.kind")).toBe("chain");
    expect(root.attributes.some((a) => a.key.startsWith("gen_ai."))).toBe(false);
  });

  it("includeContent=false の設定はスパンにも反映される", async () => {
    const trace = new TraceSession({ ...config, includeContent: false }, 0);
    trace.addLlmSpan(base);
    await trace.flush(100);

    expect(findStr(flushedSpans()[1], "gen_ai.prompt.0.content")).toBeUndefined();
  });
});
