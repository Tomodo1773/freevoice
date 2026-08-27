import { describe, it, expect, afterEach, vi } from "vitest";
import {
  postprocess,
  buildContextualUserMessage,
  buildPostprocessMessages,
  buildFormatUrl,
  buildFormatRequest,
} from "./postprocess";

function mockFetch(content = "整形済み") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], usage: {}, model: "m" }),
  });
}

describe("postprocess", () => {
  afterEach(() => vi.restoreAllMocks());

  it("渡された messages をそのまま API に送信する", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const messages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "こんにちは" },
    ];
    await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "low", messages);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.messages[1]).toEqual({ role: "user", content: "こんにちは" });
  });

  it("成功時に同じ messages を戻り値に含む", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const messages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "こんにちは" },
    ];
    const result = await postprocess("こんにちは", "openai", "", "key", "gpt-4o", "low", messages);
    expect(result.messages).toBe(messages);
  });

  it("空 transcript では messages を含まない", async () => {
    const messages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "  " },
    ];
    const result = await postprocess("  ", "openai", "", "key", "gpt-4o", "low", messages);
    expect(result.messages).toBeUndefined();
  });
});

describe("buildContextualUserMessage", () => {
  it("参照と校正対象をデリミタで分離する", () => {
    const m = buildContextualUserMessage("話題X", "本文Y");
    expect(m.role).toBe("user");
    expect(m.content).toContain("<参考トピック>\n話題X\n</参考トピック>");
    expect(m.content).toContain("<校正対象>\n本文Y\n</校正対象>");
    expect(m.content.indexOf("<参考トピック>")).toBeLessThan(m.content.indexOf("<校正対象>"));
  });
});

describe("buildPostprocessMessages", () => {
  it("文脈なし: system + user(transcript)", () => {
    const msgs = buildPostprocessMessages("SYS", "hello");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1]).toEqual({ role: "user", content: "hello" });
  });

  it("文脈あり: system + user(context+transcript)", () => {
    const msgs = buildPostprocessMessages("SYS", "hello", "CTX");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1].content).toContain("CTX");
    expect(msgs[1].content).toContain("hello");
  });

  it("空文字の文脈は注入しない", () => {
    const msgs = buildPostprocessMessages("SYS", "hello", "  ");
    expect(msgs[1].content).toBe("hello");
  });

  it("空の prompt ではデフォルトプロンプトを使用", () => {
    const msgs = buildPostprocessMessages("", "hello");
    expect(msgs[0].content).not.toBe("");
  });
});

describe("buildFormatUrl", () => {
  it("Azure は入力エンドポイントから v1 パスを組み立てる", () => {
    expect(buildFormatUrl("azure", "https://my-resource.openai.azure.com/")).toBe(
      "https://my-resource.openai.azure.com/openai/v1/chat/completions",
    );
  });

  it("OpenAI は固定エンドポイントを使い、入力エンドポイントを無視する", () => {
    expect(buildFormatUrl("openai", "https://ignored.example.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("Gemini は Google AI Studio の OpenAI 互換エンドポイントを使う", () => {
    expect(buildFormatUrl("gemini", "")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });
});

describe("buildFormatRequest", () => {
  it("Azure は api-key ヘッダーで認証する", () => {
    const { headers } = buildFormatRequest("azure", "https://my-resource.openai.azure.com", "KEY");
    expect(headers["api-key"]).toBe("KEY");
    expect(headers.Authorization).toBeUndefined();
  });

  it("OpenAI は Bearer トークンで認証する", () => {
    const { headers } = buildFormatRequest("openai", "", "KEY");
    expect(headers.Authorization).toBe("Bearer KEY");
    expect(headers["api-key"]).toBeUndefined();
  });

  it("Gemini は Bearer トークンで認証する", () => {
    const { headers } = buildFormatRequest("gemini", "", "KEY");
    expect(headers.Authorization).toBe("Bearer KEY");
    expect(headers["api-key"]).toBeUndefined();
  });
});
