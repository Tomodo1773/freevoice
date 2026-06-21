import { describe, it, expect, afterEach, vi } from "vitest";
import { postprocess, buildContextMessage } from "./postprocess";

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

  it("文脈ありは system + user(文脈) + user(transcript) の3件", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "SYS", "low", "話題A");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("話題A");
    expect(body.messages[2].content).toBe("こんにちは");
  });

  it("空文字の文脈は注入しない", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "SYS", "low", "   ");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
  });

  it("buildContextMessage は user ロールで話題を含む", () => {
    const m = buildContextMessage("話題X");
    expect(m.role).toBe("user");
    expect(m.content).toContain("話題X");
  });
});
