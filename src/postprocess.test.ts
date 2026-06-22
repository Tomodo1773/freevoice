import { describe, it, expect, afterEach, vi } from "vitest";
import { postprocess, buildContextualUserMessage } from "./postprocess";

function mockFetch(content = "整形済み") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], usage: {}, model: "m" }),
  });
}

describe("postprocess messages 構築", () => {
  afterEach(() => vi.restoreAllMocks());

  it("文脈なしは system + user(transcript) の2件", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "SYS", "low");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("SYS");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("こんにちは");
  });

  it("文脈ありは system + user(参照+校正対象) の2件にまとめる", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "SYS", "low", "話題A");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    // 参照トピックと校正対象が1つの user メッセージにデリミタ分離されている
    expect(body.messages[1].content).toContain("<参考トピック>");
    expect(body.messages[1].content).toContain("話題A");
    expect(body.messages[1].content).toContain("<校正対象>");
    expect(body.messages[1].content).toContain("こんにちは");
  });

  it("空文字の文脈は注入しない", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "SYS", "low", "   ");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
  });

  it("buildContextualUserMessage は参照と校正対象をデリミタで分離する", () => {
    const m = buildContextualUserMessage("話題X", "本文Y");
    expect(m.role).toBe("user");
    expect(m.content).toContain("<参考トピック>\n話題X\n</参考トピック>");
    expect(m.content).toContain("<校正対象>\n本文Y\n</校正対象>");
    // 校正対象が参照トピックより後ろにある（直近指示として効くように）
    expect(m.content.indexOf("<参考トピック>")).toBeLessThan(m.content.indexOf("<校正対象>"));
  });
});
