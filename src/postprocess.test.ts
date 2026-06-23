import { describe, it, expect } from "vitest";
import { buildContextualUserMessage, buildPostprocessMessages } from "./postprocess";

describe("buildPostprocessMessages", () => {
  it("文脈なしは system + user(transcript) の2件", () => {
    const messages = buildPostprocessMessages("こんにちは", "SYS");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("SYS");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("こんにちは");
  });

  it("文脈ありは system + user(参照+校正対象) の2件にまとめる", () => {
    const messages = buildPostprocessMessages("こんにちは", "SYS", "話題A");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("<参考トピック>");
    expect(messages[1].content).toContain("話題A");
    expect(messages[1].content).toContain("<校正対象>");
    expect(messages[1].content).toContain("こんにちは");
  });

  it("空文字の文脈は注入しない", () => {
    const messages = buildPostprocessMessages("こんにちは", "SYS", "   ");
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("こんにちは");
  });

  it("空の prompt はデフォルト設定のプロンプトを使用する", () => {
    const messages = buildPostprocessMessages("テスト", "");
    expect(messages[0].content).toContain("音声文字起こし結果を校正する");
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
