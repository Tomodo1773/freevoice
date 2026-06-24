import { describe, it, expect } from "vitest";
import { buildFormatSpanPayload, FormatSpanParams } from "./langsmithTrace";

type Payload = ReturnType<typeof buildFormatSpanPayload>;

function findStr(payload: Payload, key: string): string | undefined {
  const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  const attr = span.attributes.find((a: any) => a.key === key);
  return attr?.value?.stringValue;
}

const base: FormatSpanParams = {
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

describe("buildFormatSpanPayload prompt index", () => {
  it("文脈なし: prompt.0=system, prompt.1=user, prompt.2は無し", () => {
    const p = buildFormatSpanPayload(base, "proj");
    expect(findStr(p, "gen_ai.prompt.0.role")).toBe("system");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("文脈あり: messages配列がそのまま反映される", () => {
    const p = buildFormatSpanPayload({
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
    const p = buildFormatSpanPayload({ ...base, includeContent: false }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(findStr(p, "gen_ai.prompt.1.content")).toBeUndefined();
  });

  it("空の messages ではプロンプト内容を含めない", () => {
    const p = buildFormatSpanPayload({ ...base, messages: [] }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
  });
});
