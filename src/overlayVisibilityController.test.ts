import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayVisibilityController } from "./overlayVisibilityController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("OverlayVisibilityController", () => {
  it("実行中の旧hide後にも最新showを直列実行する", async () => {
    const events: string[] = [];
    const hiding = deferred<void>();
    const controller = new OverlayVisibilityController({
      position: vi.fn(async () => {
        events.push("position");
      }),
      show: vi.fn(async () => {
        events.push("show");
      }),
      hide: vi.fn(async () => {
        events.push("hide:start");
        await hiding.promise;
        events.push("hide:end");
      }),
    });

    const oldToken = controller.show();
    await controller.whenIdle();
    const oldHide = controller.hide(oldToken);
    await Promise.resolve();
    controller.show();
    hiding.resolve();

    await oldHide;
    await controller.whenIdle();
    expect(events).toEqual([
      "position",
      "show",
      "hide:start",
      "hide:end",
      "position",
      "show",
    ]);
  });

  it("旧tokenのhideは新しい表示へ触れない", async () => {
    const hide = vi.fn(async () => {});
    const controller = new OverlayVisibilityController({
      position: vi.fn(async () => {}),
      show: vi.fn(async () => {}),
      hide,
    });
    const oldToken = controller.show();
    controller.show();

    await expect(controller.hide(oldToken)).resolves.toBe(false);
    await controller.whenIdle();
    expect(hide).not.toHaveBeenCalled();
  });

  it("戻らないhideを期限後に追い越し、遅延完了時は最新showで補償する", async () => {
    vi.useFakeTimers();
    const hiding = deferred<void>();
    const show = vi.fn(async () => {});
    const controller = new OverlayVisibilityController(
      {
        position: vi.fn(async () => {}),
        show,
        hide: vi.fn(() => hiding.promise),
      },
      undefined,
      10,
    );
    const oldToken = controller.show();
    await controller.whenIdle();
    const oldHide = controller.hide(oldToken);
    await Promise.resolve();
    controller.show();

    await vi.advanceTimersByTimeAsync(10);
    await oldHide;
    await controller.whenIdle();
    expect(show).toHaveBeenCalledTimes(2);

    hiding.resolve();
    await Promise.resolve();
    await controller.whenIdle();
    expect(show).toHaveBeenCalledTimes(3);
  });
});
