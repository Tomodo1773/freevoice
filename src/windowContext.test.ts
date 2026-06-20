import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getContext,
  updateContext,
  withInFlightGuard,
  _resetForTest,
} from "./windowContext";

beforeEach(() => {
  _resetForTest();
});

describe("windowContext", () => {
  describe("getContext / updateContext", () => {
    it("更新したサマリを取得できる", () => {
      updateContext("w1", "chrome.exe", "title", "話題A");
      expect(getContext("w1")).toBe("話題A");
    });

    it("未登録の id は null", () => {
      expect(getContext("none")).toBeNull();
    });

    it("空 id・空サマリは登録しない", () => {
      updateContext("", "e", "t", "x");
      updateContext("w", "e", "t", "   ");
      expect(getContext("w")).toBeNull();
    });

    it("サマリはトリムして保存される", () => {
      updateContext("w1", "e", "t", "  話題  ");
      expect(getContext("w1")).toBe("話題");
    });
  });

  describe("TTL（30分）", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("30分以内は保持される", () => {
      updateContext("w1", "e", "t", "話題");
      vi.advanceTimersByTime(29 * 60 * 1000);
      expect(getContext("w1")).toBe("話題");
    });

    it("30分超で破棄され null になる", () => {
      updateContext("w1", "e", "t", "話題");
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(getContext("w1")).toBeNull();
      // 破棄済みなので再取得も null
      expect(getContext("w1")).toBeNull();
    });
  });

  describe("LRU 上限（20件）", () => {
    it("上限を超えると最古から evict される", () => {
      for (let i = 0; i < 25; i++) {
        updateContext(`w${i}`, "e", "t", `話題${i}`);
      }
      // 最初の5件は押し出され、最新20件が残る
      expect(getContext("w0")).toBeNull();
      expect(getContext("w4")).toBeNull();
      expect(getContext("w5")).toBe("話題5");
      expect(getContext("w24")).toBe("話題24");
    });

    it("再更新したエントリは最新扱いになり evict されにくい", () => {
      for (let i = 0; i < 20; i++) updateContext(`w${i}`, "e", "t", `v${i}`);
      updateContext("w0", "e", "t", "v0b"); // 末尾へ移動
      updateContext("w20", "e", "t", "v20"); // 最古(w1)を押し出す
      expect(getContext("w1")).toBeNull();
      expect(getContext("w0")).toBe("v0b");
    });
  });

  describe("withInFlightGuard", () => {
    it("実行中の同一 id は二重起動せずスキップする", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let runs = 0;
      const p1 = withInFlightGuard("w1", async () => {
        runs++;
        await gate;
      });
      const p2 = withInFlightGuard("w1", async () => {
        runs++;
      });
      expect(await p2).toBe(false);
      release();
      expect(await p1).toBe(true);
      expect(runs).toBe(1);
    });

    it("別 id は並行実行できる", async () => {
      let runs = 0;
      const p1 = withInFlightGuard("a", async () => { runs++; });
      const p2 = withInFlightGuard("b", async () => { runs++; });
      expect(await p1).toBe(true);
      expect(await p2).toBe(true);
      expect(runs).toBe(2);
    });

    it("完了後は同じ id を再実行できる", async () => {
      expect(await withInFlightGuard("w", async () => {})).toBe(true);
      expect(await withInFlightGuard("w", async () => {})).toBe(true);
    });

    it("例外発生時も in-flight を解放する", async () => {
      await expect(
        withInFlightGuard("w", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      // 解放済みなので再実行できる
      expect(await withInFlightGuard("w", async () => {})).toBe(true);
    });
  });
});
