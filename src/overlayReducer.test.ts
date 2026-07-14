import { describe, it, expect } from "vitest";
import {
  overlayReducer,
  initialState,
  decideReadyEdge,
  decideStartEdge,
  decideStopEdge,
  OverlayState,
  OverlayAction,
} from "./overlayReducer";

/** reducer を連続適用するヘルパー */
function applyActions(state: OverlayState, actions: OverlayAction[]): OverlayState {
  return actions.reduce(overlayReducer, state);
}

describe("overlayReducer", () => {
  describe("正常フロー", () => {
    it("idle → starting → recording → transcribing → formatting → done", () => {
      const s1 = overlayReducer(initialState, { type: "RECORDING_START" });
      expect(s1.phase).toBe("starting");
      expect(s1.hideRequest).toBeNull();

      const s2 = overlayReducer(s1, { type: "RECORDING_READY" });
      expect(s2.phase).toBe("recording");

      const s3 = overlayReducer(s2, { type: "STOP_TRANSCRIBING" });
      expect(s3.phase).toBe("transcribing");

      const s4 = overlayReducer(s3, { type: "TRANSCRIPT_READY", transcript: "こんにちは" });
      expect(s4.phase).toBe("formatting");
      expect(s4.transcript).toBe("こんにちは");

      const s5 = overlayReducer(s4, { type: "FORMAT_DONE" });
      expect(s5.phase).toBe("done");
      expect(s5.hideRequest).not.toBeNull();
      expect(s5.hideRequest!.ms).toBe(1000);
    });

    it("done → BEGIN_FADE → FADE_DONE → idle", () => {
      const done = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE" },
      ]);

      const fading = overlayReducer(done, { type: "BEGIN_FADE" });
      expect(fading.fading).toBe(true);
      expect(fading.hideRequest).toBeNull();

      const idle = overlayReducer(fading, { type: "FADE_DONE" });
      expect(idle).toEqual(initialState);
    });
  });

  describe("開始中の停止予約", () => {
    it("starting中のReleaseを保持し、開始完了後に停止へ進める", () => {
      const starting = overlayReducer(initialState, { type: "RECORDING_START" });
      const pending = overlayReducer(starting, { type: "RECORDING_STOP_REQUESTED" });
      expect(pending.phase).toBe("stop-pending");

      const ready = overlayReducer(pending, { type: "RECORDING_READY" });
      expect(ready.phase).toBe("recording");

      const transcribing = overlayReducer(ready, { type: "STOP_TRANSCRIBING" });
      expect(transcribing.phase).toBe("transcribing");
    });

    it("停止予約が重複しても状態を増やさない", () => {
      const pending = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_STOP_REQUESTED" },
      ]);
      const duplicate = overlayReducer(pending, { type: "RECORDING_STOP_REQUESTED" });
      expect(duplicate).toBe(pending);
    });

    it("stop-pending中のストール再試行は停止予約を捨ててstartingへ戻す", () => {
      const pending = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_STOP_REQUESTED" },
      ]);

      const restarted = overlayReducer(pending, { type: "RECORDING_RESTART" });
      expect(restarted).toEqual({ ...initialState, phase: "starting" });
      expect(decideReadyEdge(restarted.phase)).toBe("record");
    });

    it("開始完了時は停止予約の有無から継続か即時停止かを一意に決める", () => {
      expect(decideReadyEdge("starting")).toBe("record");
      expect(decideReadyEdge("stop-pending")).toBe("stop");
      expect(decideReadyEdge("error")).toBe("discard");
    });
  });

  describe("連続録音（今回のバグの根本原因）", () => {
    it("done（hideRequest有）→ RECORDING_START → starting（hideRequest=null）", () => {
      const done = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE" },
      ]);
      expect(done.hideRequest).not.toBeNull();

      // BEGIN_FADE が来る前に次の録音開始 → done から直接 starting へ
      const starting = overlayReducer(done, { type: "RECORDING_START" });
      expect(starting.phase).toBe("starting");
      expect(starting.hideRequest).toBeNull();
      expect(starting.transcript).toBe("");
    });

    it("error → RECORDING_START → starting", () => {
      const error = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_FAILED", errorMsg: "マイクエラー" },
      ]);
      expect(error.phase).toBe("error");

      const starting = overlayReducer(error, { type: "RECORDING_START" });
      expect(starting.phase).toBe("starting");
      expect(starting.hideRequest).toBeNull();
      expect(starting.errorMsg).toBe("");
    });

    it("transcribing → RECORDING_START は拒否", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
      ]);
      const result = overlayReducer(transcribing, { type: "RECORDING_START" });
      expect(result.phase).toBe("transcribing");
    });

    it("formatting → RECORDING_START は拒否", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);
      const result = overlayReducer(formatting, { type: "RECORDING_START" });
      expect(result.phase).toBe("formatting");
    });

    it("fading 中の再録音が正しく動く", () => {
      const fading = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE" },
        { type: "BEGIN_FADE" },
      ]);
      expect(fading.fading).toBe(true);

      const starting = overlayReducer(fading, { type: "RECORDING_START" });
      expect(starting.phase).toBe("starting");
      expect(starting.fading).toBe(false);
      expect(starting.hideRequest).toBeNull();
      expect(starting.transcript).toBe("");
    });
  });

  describe("空結果", () => {
    it("無音の場合: transcribing → nospeech + 1500ms hide", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const result = overlayReducer(transcribing, { type: "TRANSCRIPT_EMPTY", silent: true });
      expect(result.phase).toBe("nospeech");
      expect(result.transcript).toBe("音声が検出されませんでした");
      expect(result.hideRequest!.ms).toBe(1500);
    });

    it("非無音の空結果: transcribing → nospeech + 150ms hide（成功表示は出さない）", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const result = overlayReducer(transcribing, { type: "TRANSCRIPT_EMPTY", silent: false });
      expect(result.phase).toBe("nospeech");
      expect(result.transcript).toBe("音声が検出されませんでした");
      expect(result.hideRequest!.ms).toBe(150);
    });

    it("nospeech（無音終端）→ RECORDING_START → starting（リトライできる）", () => {
      const nospeech = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_EMPTY", silent: true },
      ]);
      expect(nospeech.phase).toBe("nospeech");

      const starting = overlayReducer(nospeech, { type: "RECORDING_START" });
      expect(starting.phase).toBe("starting");
      expect(starting.hideRequest).toBeNull();
      expect(starting.transcript).toBe("");
    });
  });

  describe("エラーフロー", () => {
    it("starting → RECORDING_FAILED → error + 5000ms hide", () => {
      const recording = overlayReducer(initialState, { type: "RECORDING_START" });
      const error = overlayReducer(recording, { type: "RECORDING_FAILED", errorMsg: "マイクエラー" });

      expect(error.phase).toBe("error");
      expect(error.errorMsg).toBe("マイクエラー");
      expect(error.hideRequest!.ms).toBe(5000);
    });

    it("transcribing → STOP_ERROR → error + 5000ms hide", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const error = overlayReducer(transcribing, { type: "STOP_ERROR", errorMsg: "APIエラー" });
      expect(error.phase).toBe("error");
      expect(error.errorMsg).toBe("APIエラー");
      expect(error.hideRequest!.ms).toBe(5000);
    });

    it("formatting → STOP_ERROR → error + 5000ms hide", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);

      const error = overlayReducer(formatting, { type: "STOP_ERROR", errorMsg: "後処理エラー" });
      expect(error.phase).toBe("error");
      expect(error.hideRequest!.ms).toBe(5000);
    });
  });

  describe("abort", () => {
    it("transcribing → ABORT_CANCELLED → idle", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const idle = overlayReducer(transcribing, { type: "ABORT_CANCELLED" });
      expect(idle).toEqual(initialState);
    });

    it("formatting → ABORT_CANCELLED → idle", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);

      const idle = overlayReducer(formatting, { type: "ABORT_CANCELLED" });
      expect(idle).toEqual(initialState);
    });
  });

  describe("フォールバック", () => {
    it("FORMAT_DONE + fallback: true → fallback=true, hideRequest.ms=3000", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);

      const done = overlayReducer(formatting, { type: "FORMAT_DONE", fallback: true });
      expect(done.phase).toBe("done");
      expect(done.fallback).toBe(true);
      expect(done.hideRequest!.ms).toBe(3000);
    });

    it("FORMAT_DONE + fallbackなし → fallback=false, hideRequest.ms=1000", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);

      const done = overlayReducer(formatting, { type: "FORMAT_DONE" });
      expect(done.phase).toBe("done");
      expect(done.fallback).toBe(false);
      expect(done.hideRequest!.ms).toBe(1000);
    });

    it("RECORDING_START で fallback がリセットされる", () => {
      const done = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE", fallback: true },
      ]);
      expect(done.fallback).toBe(true);

      const starting = overlayReducer(done, { type: "RECORDING_START" });
      expect(starting.phase).toBe("starting");
      expect(starting.fallback).toBe(false);
    });
  });

  describe("不正遷移の無視", () => {
    it("idle → STOP_TRANSCRIBING は無視", () => {
      const result = overlayReducer(initialState, { type: "STOP_TRANSCRIBING" });
      expect(result).toEqual(initialState);
    });

    it("idle → FORMAT_DONE は無視", () => {
      const result = overlayReducer(initialState, { type: "FORMAT_DONE" });
      expect(result).toEqual(initialState);
    });

    it("recording → FORMAT_DONE は無視", () => {
      const recording = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
      ]);
      const result = overlayReducer(recording, { type: "FORMAT_DONE" });
      expect(result).toEqual(recording);
    });

    it("idle で RECORDING_START 以外のアクションは無視", () => {
      const result = overlayReducer(initialState, { type: "SET_TRANSCRIPT", transcript: "x" });
      expect(result).toEqual(initialState);
    });
  });

  describe("キーエッジ判定（ガード単一化）", () => {
    it("decideStartEdge: idle/done/error/nospeech は start", () => {
      expect(decideStartEdge("idle")).toBe("start");
      expect(decideStartEdge("done")).toBe("start");
      expect(decideStartEdge("error")).toBe("start");
      expect(decideStartEdge("nospeech")).toBe("start");
    });

    it("decideStartEdge: starting/stop-pending/recording は ignore", () => {
      expect(decideStartEdge("starting")).toBe("ignore");
      expect(decideStartEdge("stop-pending")).toBe("ignore");
      expect(decideStartEdge("recording")).toBe("ignore");
    });

    it("decideStartEdge: transcribing/formatting は cancel", () => {
      expect(decideStartEdge("transcribing")).toBe("cancel");
      expect(decideStartEdge("formatting")).toBe("cancel");
    });

    it("decideStopEdge: starting中はrequest、recording中はstop", () => {
      expect(decideStopEdge("starting")).toBe("request");
      expect(decideStopEdge("stop-pending")).toBe("request");
      expect(decideStopEdge("recording")).toBe("stop");
      expect(decideStopEdge("idle")).toBe("ignore");
      expect(decideStopEdge("transcribing")).toBe("ignore");
      expect(decideStopEdge("formatting")).toBe("ignore");
      expect(decideStopEdge("done")).toBe("ignore");
      expect(decideStopEdge("error")).toBe("ignore");
      expect(decideStopEdge("nospeech")).toBe("ignore");
    });
  });

  describe("hideRequest の seq がインクリメントされる", () => {
    it("通常フローの hideRequest は seq=1", () => {
      const s1 = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_READY" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_EMPTY", silent: true },
      ]);
      expect(s1.hideRequest!.seq).toBe(1);
    });

    it("既存の hideRequest を持つ状態からの新たな hideRequest は seq を +1 する", () => {
      // seq は「非表示予約の世代」。前回の予約が残る状態から新たな予約が入ると加算される。
      const base: OverlayState = {
        ...initialState,
        phase: "recording",
        hideRequest: { ms: 100, seq: 1 },
      };
      const failed = overlayReducer(base, { type: "RECORDING_FAILED", errorMsg: "err" });
      expect(failed.hideRequest!.seq).toBe(2);
    });
  });
});
