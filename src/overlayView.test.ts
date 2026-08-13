import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OverlayView } from "./overlayView";

function makeView() {
  const showWindow = vi.fn();
  const hideWindow = vi.fn();
  const view = new OverlayView({ showWindow, hideWindow });
  return { view, showWindow, hideWindow };
}

describe("OverlayView", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starting() でウィンドウを表示し status=starting にする", () => {
    const { view, showWindow } = makeView();
    view.starting();
    expect(view.getState().status).toBe("starting");
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it("recording() は表示済みの Preparing を Recording に切り替える", () => {
    const { view, showWindow } = makeView();
    view.starting();
    view.recording();
    expect(view.getState().status).toBe("recording");
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it("done() は linger(1000ms)→fade(400ms) を経てウィンドウを隠し hidden に戻る", () => {
    const { view, hideWindow } = makeView();
    view.recording();
    view.done(false, "");
    expect(view.getState().status).toBe("done");
    expect(view.getState().fading).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(view.getState().fading).toBe(true);
    expect(hideWindow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(hideWindow).toHaveBeenCalledTimes(1);
    expect(view.getState().status).toBe("hidden");
  });

  it("fallback の done は 3000ms 表示する", () => {
    const { view } = makeView();
    view.recording();
    view.done(true, "レート制限");
    vi.advanceTimersByTime(2999);
    expect(view.getState().fading).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.getState().fading).toBe(true);
  });

  it("error() は 5000ms 表示してからフェードする", () => {
    const { view } = makeView();
    view.recording();
    view.error("失敗");
    expect(view.getState().status).toBe("error");
    expect(view.getState().errorMsg).toBe("失敗");
    vi.advanceTimersByTime(4999);
    expect(view.getState().fading).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view.getState().fading).toBe(true);
  });

  it("empty(silent) は 1500ms、empty(false) は 150ms 表示する", () => {
    const a = makeView();
    a.view.recording();
    a.view.empty(true);
    expect(a.view.getState().transcript).toBe("音声が検出されませんでした");
    a.view.recording(); // reset timers
    a.view.empty(false);
    vi.advanceTimersByTime(149);
    expect(a.view.getState().fading).toBe(false);
    vi.advanceTimersByTime(1);
    expect(a.view.getState().fading).toBe(true);
  });

  it("cancelled() は即座にウィンドウを隠し hidden に戻す（フェードなし）", () => {
    const { view, hideWindow } = makeView();
    view.recording();
    view.transcribing();
    view.cancelled();
    expect(hideWindow).toHaveBeenCalledTimes(1);
    expect(view.getState().status).toBe("hidden");
  });

  it("トースト表示中に新しい starting() が来ると、保留中の非表示をキャンセルする", () => {
    const { view, showWindow, hideWindow } = makeView();
    view.starting();
    view.done(false, "");
    vi.advanceTimersByTime(500); // linger 途中
    view.starting(); // 次の録音開始
    expect(view.getState().status).toBe("starting");
    expect(showWindow).toHaveBeenCalledTimes(2);

    // 元の done のタイマーが残って隠さないことを確認
    vi.advanceTimersByTime(2000);
    expect(hideWindow).not.toHaveBeenCalled();
    expect(view.getState().status).toBe("starting");
  });

  it("フェード完了後に late な transcript() が来ても hidden のまま無視する", () => {
    const { view } = makeView();
    view.recording();
    view.done(false, "");
    vi.advanceTimersByTime(1400); // linger + fade 完了
    expect(view.getState().status).toBe("hidden");
    view.transcript("遅れて届いた");
    expect(view.getState().transcript).toBe("");
  });

  it("subscribe した listener が状態変化で通知される", () => {
    const { view } = makeView();
    const listener = vi.fn();
    const unsub = view.subscribe(listener);
    view.recording();
    expect(listener).toHaveBeenCalled();
    unsub();
    const before = listener.mock.calls.length;
    view.transcribing();
    expect(listener.mock.calls.length).toBe(before);
  });
});
