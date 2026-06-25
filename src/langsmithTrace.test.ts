import { describe, it, expect } from "vitest";
import { buildLlmSpanPayload, LlmSpanParams } from "./langsmithTrace";

type Payload = ReturnType<typeof buildLlmSpanPayload>;

function findStr(payload: Payload, key: string): string | undefined {
  const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  const attr = span.attributes.find((a: any) => a.key === key);
  return attr?.value?.stringValue;
}

function spanName(payload: Payload): string {
  return (payload as any).resourceSpans[0].scopeSpans[0].spans[0].name;
}

const base: LlmSpanParams = {
  spanName: "format",
  provider: "openai",
  requestModel: "gpt-4o",
  messages: [
    { role: "system", content: "SYS" },
    { role: "user", content: "TR" },
  ],
  reasoningEffort: "low",
  startTimeMs: 0,
  endTimeMs: 1,
  includeContent: true,
};

describe("buildLlmSpanPayload", () => {
  it("spanName がスパン名と freevoice.operation 属性に反映される", () => {
    const p = buildLlmSpanPayload(base, "proj");
    expect(spanName(p)).toBe("format");
    expect(findStr(p, "freevoice.operation")).toBe("format");

    const d = buildLlmSpanPayload({ ...base, spanName: "distill" }, "proj");
    expect(spanName(d)).toBe("distill");
    expect(findStr(d, "freevoice.operation")).toBe("distill");
  });

  it("文脈なし: prompt.0=system, prompt.1=user, prompt.2は無し", () => {
    const p = buildLlmSpanPayload(base, "proj");
    expect(findStr(p, "gen_ai.prompt.0.role")).toBe("system");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("文脈あり: messages配列がそのまま反映される", () => {
    const p = buildLlmSpanPayload({
      ...base,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "<参考トピック>\nCTX\n</参考トピック>\n\nTR" },
      ],
    }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toContain("CTX");
    expect(findStr(p, "gen_ai.prompt.1.content")).toContain("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("includeContent=false ではプロンプト内容を含めない", () => {
    const p = buildLlmSpanPayload({ ...base, includeContent: false }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(findStr(p, "gen_ai.prompt.1.content")).toBeUndefined();
  });

  it("空の messages ではプロンプト内容を含めない", () => {
    const p = buildLlmSpanPayload({ ...base, messages: [] }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
  });
});
