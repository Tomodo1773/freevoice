import { afterEach, describe, expect, it, vi } from "vitest";
import { PasteQueue } from "./pasteQueue";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("PasteQueue", () => {
  it("前のpasteが完了するまで次のpasteを開始しない", async () => {
    const firstGate = deferred<void>();
    const events: string[] = [];
    const queue = new PasteQueue();
    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second");
    });

    await flush();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("実行中pasteのcallerをcancelしても、実処理終了までは次を止める", async () => {
    const firstGate = deferred<void>();
    const controller = new AbortController();
    const secondPaste = vi.fn(async () => {});
    const queue = new PasteQueue();
    const first = queue.run(() => firstGate.promise, { signal: controller.signal });
    await flush();

    controller.abort(new DOMException("cancel", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = queue.run(secondPaste);
    await flush();
    expect(secondPaste).not.toHaveBeenCalled();

    firstGate.resolve();
    await second;
    expect(secondPaste).toHaveBeenCalledOnce();
  });

  it("pasteが戻らなくてもcallerへ明示的なtimeoutを返す", async () => {
    vi.useFakeTimers();
    const queue = new PasteQueue();
    const result = queue.run(() => new Promise<void>(() => {}), { timeoutMs: 100 });
    const rejected = expect(result).rejects.toThrow("貼り付け処理がタイムアウトしました");

    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it("queue待機中にtimeoutしたpasteは、先行処理完了後も実行しない", async () => {
    vi.useFakeTimers();
    const firstGate = deferred<void>();
    const latePaste = vi.fn(async () => {});
    const queue = new PasteQueue();
    const first = queue.run(() => firstGate.promise, { timeoutMs: 1_000 });
    const second = queue.run(latePaste, { timeoutMs: 100 });
    const rejected = expect(second).rejects.toThrow("貼り付け処理がタイムアウトしました");

    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    firstGate.resolve();
    await first;
    await queue.whenIdle();
    expect(latePaste).not.toHaveBeenCalled();
  });
});
