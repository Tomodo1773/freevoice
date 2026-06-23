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
  it("文脈なし: messages 配列がそのまま prompt 属性になる", () => {
    const p = buildFormatSpanPayload(base, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    expect(findStr(p, "gen_ai.prompt.1.content")).toBe("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("文脈あり: messages に XMLタグ統合済みの user メッセージが含まれる", () => {
    const contextMessages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "<参考トピック>\nCTX\n</参考トピック>\n\n上記は誤変換補正のヒントであり、出力対象ではない。次の <校正対象> のテキストのみを校正して出力する。\n\n<校正対象>\nTR\n</校正対象>" },
    ];
    const p = buildFormatSpanPayload({ ...base, messages: contextMessages }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBe("SYS");
    expect(findStr(p, "gen_ai.prompt.1.role")).toBe("user");
    const content = findStr(p, "gen_ai.prompt.1.content")!;
    expect(content).toContain("<参考トピック>");
    expect(content).toContain("CTX");
    expect(content).toContain("<校正対象>");
    expect(content).toContain("TR");
    expect(findStr(p, "gen_ai.prompt.2.content")).toBeUndefined();
  });

  it("includeContent=false ではプロンプト内容を含めない", () => {
    const p = buildFormatSpanPayload({ ...base, includeContent: false }, "proj");
    expect(findStr(p, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(findStr(p, "gen_ai.prompt.1.content")).toBeUndefined();
  });
});
