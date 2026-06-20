import { describe, it, expect } from "vitest";
import { buildFormatSpanPayload, FormatSpanParams } from "./langsmithTrace";

type Payload = ReturnType<typeof buildFormatSpanPayload>;

function findStr(payload: Payload, key: string): string | undefined {
  // payload は OTLP 構造。spans[0].attributes から該当 key の stringValue を取り出す
  const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  const attr = span.attributes.find((a: any) => a.key === key);
  return attr?.value?.stringValue;
}

const base: FormatSpanParams = {
  provider: "openai",
  requestModel: "gpt-4o",
  systemPrompt: "SYS",
  userTranscript: "TR",
  reasoningEffort: "low",
  startTimeMs: 0,
  endTimeMs: 1,
  includeContent: true,
};

describe("buildFormatSpanPayload prompt index", () => {
  it("文脈なし: prompt.1 が transcript、prompt.2 は無し", () => {
    const p = buildFormatSpanPayload(base, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("文脈あり: prompt.1=文脈, prompt.2=transcript", () => {
    const p = buildFormatSpanPayload({ ...base, userContext: "CTX" }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("CTX");
    expect(findStr(p, "gen_ai.prompt.2.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBe("TR");
  });

  it("includeContent=false ではプロンプト内容を含めない", () => {
    const p = buildFormatSpanPayload({ ...base, includeContent: false, userContext: "CTX" }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(findStr(p, "gen_ai.prompt.1.content")).toBeUndefined();
  });
});
