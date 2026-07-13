import { describe, expect, it, vi } from "vitest";
import {
  createOverlayStore,
  initialState,
  overlayReducer,
  type OverlayAction,
  type OverlayState,
} from "./overlayReducer";

function applyActions(state: OverlayState, actions: OverlayAction[]): OverlayState {
  return actions.reduce(overlayReducer, state);
}

const start = (attemptId = 1, stopRequested = false): OverlayAction => ({
  type: "CAPTURE_STATE",
  status: "starting",
  attemptId,
  mode: "hold",
  stopRequested,
  interim: "",
});

const ready = (attemptId = 1, interim = ""): OverlayAction => ({
  type: "CAPTURE_STATE",
  status: "recording",
  attemptId,
  mode: "hold",
  stopRequested: false,
  interim,
});

const stopping = (attemptId = 1, interim = ""): OverlayAction => ({
  type: "CAPTURE_STATE",
  status: "stopping",
  attemptId,
  mode: "hold",
  stopRequested: false,
  interim,
});

describe("overlayReducer", () => {
  it("録音から整形完了までの表示状態を反映する", () => {
    const states = [
      overlayReducer(initialState, start()),
    ];
    states.push(overlayReducer(states[states.length - 1], ready(1, "途中")));
    states.push(overlayReducer(states[states.length - 1], stopping(1, "確定前")));
    states.push(overlayReducer(states[states.length - 1], {
      type: "TRANSCRIPT_READY",
      transcript: "こんにちは",
    }));
    states.push(overlayReducer(states[states.length - 1], { type: "FORMAT_DONE" }));

    expect(states.map((state) => state.phase)).toEqual([
      "starting",
      "recording",
      "transcribing",
      "formatting",
      "done",
    ]);
    expect(states[states.length - 1].hideRequest?.ms).toBe(1000);
  });

  it("starting中の停止予約を表示状態へ反映する", () => {
    const starting = overlayReducer(initialState, start());
    const pending = overlayReducer(starting, start(1, true));
    expect(pending.phase).toBe("starting");
    expect(pending.stopRequested).toBe(true);
  });

  it("toggleモードはattempt単位で保持する", () => {
    const state = overlayReducer(initialState, {
      type: "CAPTURE_STATE",
      status: "starting",
      attemptId: 4,
      mode: "toggle",
      stopRequested: false,
      interim: "",
    });
    expect(state.captureAttemptId).toBe(4);
    expect(state.captureMode).toBe("toggle");
  });

  it("新しいattemptは古い完了表示と非表示予約をリセットする", () => {
    const done = applyActions(initialState, [
      start(),
      ready(),
      stopping(),
      { type: "TRANSCRIPT_READY", transcript: "test" },
      { type: "FORMAT_DONE", fallback: true, fallbackReason: "format error" },
    ]);
    const next = overlayReducer(done, start(2));
    expect(next).toMatchObject({
      phase: "starting",
      captureAttemptId: 2,
      transcript: "",
      fallback: false,
      fading: false,
      hideRequest: null,
    });
  });

  it("古いattemptのrecording/stopping通知を無視する", () => {
    const current = overlayReducer(initialState, start(2));
    expect(overlayReducer(current, ready(1))).toEqual(current);
    expect(overlayReducer(current, stopping(1))).toEqual(current);
  });

  it("認識エラーはcapture情報を消してerror表示にする", () => {
    const recording = applyActions(initialState, [start(), ready()]);
    const error = overlayReducer(recording, {
      type: "CAPTURE_FAILED",
      errorMsg: "音声認識が切断されました",
    });
    expect(error).toMatchObject({
      phase: "error",
      captureAttemptId: null,
      captureMode: null,
      errorMsg: "音声認識が切断されました",
    });
    expect(error.hideRequest?.ms).toBe(5000);
  });

  it("captureキャンセルはidleへ戻す", () => {
    const starting = overlayReducer(initialState, start());
    expect(overlayReducer(starting, { type: "CAPTURE_CANCELLED" })).toEqual(initialState);
  });

  it("無音結果はnospeechとして表示する", () => {
    const transcribing = applyActions(initialState, [start(), ready(), stopping()]);
    const silent = overlayReducer(transcribing, {
      type: "TRANSCRIPT_EMPTY",
      silent: true,
    });
    expect(silent.phase).toBe("nospeech");
    expect(silent.transcript).toBe("音声が検出されませんでした");
    expect(silent.hideRequest?.ms).toBe(1500);
  });

  it("非無音の空結果は短時間で閉じる", () => {
    const transcribing = applyActions(initialState, [start(), ready(), stopping()]);
    const empty = overlayReducer(transcribing, {
      type: "TRANSCRIPT_EMPTY",
      silent: false,
    });
    expect(empty.hideRequest?.ms).toBe(150);
  });

  it("整形fallbackは理由を保持して3秒表示する", () => {
    const formatting = applyActions(initialState, [
      start(),
      ready(),
      stopping(),
      { type: "TRANSCRIPT_READY", transcript: "raw" },
    ]);
    const done = overlayReducer(formatting, {
      type: "FORMAT_DONE",
      fallback: true,
      fallbackReason: "timeout",
    });
    expect(done).toMatchObject({
      phase: "done",
      fallback: true,
      fallbackReason: "timeout",
    });
    expect(done.hideRequest?.ms).toBe(3000);
  });

  it("postprocessの失敗とキャンセルを分ける", () => {
    const transcribing = applyActions(initialState, [start(), ready(), stopping()]);
    const error = overlayReducer(transcribing, {
      type: "POSTPROCESS_ERROR",
      errorMsg: "整形エラー",
    });
    expect(error.phase).toBe("error");

    const cancelled = overlayReducer(transcribing, {
      type: "POSTPROCESS_CANCELLED",
    });
    expect(cancelled).toEqual(initialState);
  });

  it("無効な処理遷移を拒否する", () => {
    expect(
      overlayReducer(initialState, { type: "TRANSCRIPT_READY", transcript: "x" }),
    ).toEqual(initialState);
    expect(overlayReducer(initialState, { type: "FORMAT_DONE" })).toEqual(initialState);
    expect(
      overlayReducer(initialState, { type: "POSTPROCESS_ERROR", errorMsg: "x" }),
    ).toEqual(initialState);
  });

  it("hideRequestを世代管理してfade後にidleへ戻す", () => {
    const nospeech = applyActions(initialState, [
      start(),
      ready(),
      stopping(),
      { type: "TRANSCRIPT_EMPTY", silent: true },
    ]);
    const fading = overlayReducer(nospeech, { type: "BEGIN_FADE" });
    expect(fading.fading).toBe(true);
    expect(fading.hideRequest).toBeNull();
    expect(overlayReducer(fading, { type: "FADE_DONE" })).toEqual(initialState);
  });
});

describe("createOverlayStore", () => {
  it("dispatch直後に同期的に最新の表示状態を返す", () => {
    const store = createOverlayStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch(start());
    expect(store.getState().phase).toBe("starting");
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispatch(ready());
    expect(store.getState().phase).toBe("recording");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.dispatch(stopping());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
