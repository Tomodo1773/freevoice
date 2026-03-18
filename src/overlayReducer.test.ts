import { describe, it, expect } from "vitest";
import { overlayReducer, initialState, OverlayState, OverlayAction } from "./overlayReducer";

/** reducer を連続適用するヘルパー */
function applyActions(state: OverlayState, actions: OverlayAction[]): OverlayState {
  return actions.reduce(overlayReducer, state);
}

describe("overlayReducer", () => {
  describe("正常フロー", () => {
    it("idle → recording → transcribing → formatting → done", () => {
      const s1 = overlayReducer(initialState, { type: "RECORDING_START" });
      expect(s1.phase).toBe("recording");
      expect(s1.hideRequest).toBeNull();

      const s2 = overlayReducer(s1, { type: "STOP_TRANSCRIBING" });
      expect(s2.phase).toBe("transcribing");

      const s3 = overlayReducer(s2, { type: "TRANSCRIPT_READY", transcript: "こんにちは" });
      expect(s3.phase).toBe("formatting");
      expect(s3.transcript).toBe("こんにちは");

      const s4 = overlayReducer(s3, { type: "FORMAT_DONE" });
      expect(s4.phase).toBe("done");
      expect(s4.hideRequest).not.toBeNull();
      expect(s4.hideRequest!.ms).toBe(1000);
    });

    it("done → BEGIN_FADE → FADE_DONE → idle", () => {
      const done = applyActions(initialState, [
        { type: "RECORDING_START" },
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

  describe("連続録音（今回のバグの根本原因）", () => {
    it("done（hideRequest有）→ RECORDING_START → recording（hideRequest=null）", () => {
      const done = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE" },
      ]);
      expect(done.hideRequest).not.toBeNull();

      // BEGIN_FADE が来る前に次の録音開始 → done から直接 recording へ
      const recording = overlayReducer(done, { type: "RECORDING_START" });
      expect(recording.phase).toBe("recording");
      expect(recording.hideRequest).toBeNull();
      expect(recording.transcript).toBe("");
    });

    it("error → RECORDING_START → recording", () => {
      const error = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "RECORDING_FAILED", errorMsg: "マイクエラー" },
      ]);
      expect(error.phase).toBe("error");

      const recording = overlayReducer(error, { type: "RECORDING_START" });
      expect(recording.phase).toBe("recording");
      expect(recording.hideRequest).toBeNull();
      expect(recording.errorMsg).toBe("");
    });

    it("transcribing → RECORDING_START は拒否", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
      ]);
      const result = overlayReducer(transcribing, { type: "RECORDING_START" });
      expect(result.phase).toBe("transcribing");
    });

    it("formatting → RECORDING_START は拒否", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
      ]);
      const result = overlayReducer(formatting, { type: "RECORDING_START" });
      expect(result.phase).toBe("formatting");
    });

    it("fading 中の再録音が正しく動く", () => {
      const fading = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE" },
        { type: "BEGIN_FADE" },
      ]);
      expect(fading.fading).toBe(true);

      const recording = overlayReducer(fading, { type: "RECORDING_START" });
      expect(recording.phase).toBe("recording");
      expect(recording.fading).toBe(false);
      expect(recording.hideRequest).toBeNull();
      expect(recording.transcript).toBe("");
    });
  });

  describe("空結果", () => {
    it("無音の場合: transcribing → recording + 1500ms hide", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const result = overlayReducer(transcribing, { type: "TRANSCRIPT_EMPTY", silent: true });
      expect(result.phase).toBe("recording");
      expect(result.transcript).toBe("音声が検出されませんでした");
      expect(result.hideRequest!.ms).toBe(1500);
    });

    it("非無音の空結果: transcribing のまま + 150ms hide", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
      ]);

      const result = overlayReducer(transcribing, { type: "TRANSCRIPT_EMPTY", silent: false });
      expect(result.phase).toBe("transcribing");
      expect(result.hideRequest!.ms).toBe(150);
    });
  });

  describe("エラーフロー", () => {
    it("recording → RECORDING_FAILED → error + 5000ms hide", () => {
      const recording = overlayReducer(initialState, { type: "RECORDING_START" });
      const error = overlayReducer(recording, { type: "RECORDING_FAILED", errorMsg: "マイクエラー" });

      expect(error.phase).toBe("error");
      expect(error.errorMsg).toBe("マイクエラー");
      expect(error.hideRequest!.ms).toBe(5000);
    });

    it("transcribing → STOP_ERROR → error + 5000ms hide", () => {
      const transcribing = applyActions(initialState, [
        { type: "RECORDING_START" },
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
        { type: "STOP_TRANSCRIBING" },
      ]);

      const idle = overlayReducer(transcribing, { type: "ABORT_CANCELLED" });
      expect(idle).toEqual(initialState);
    });

    it("formatting → ABORT_CANCELLED → idle", () => {
      const formatting = applyActions(initialState, [
        { type: "RECORDING_START" },
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
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_READY", transcript: "test" },
        { type: "FORMAT_DONE", fallback: true },
      ]);
      expect(done.fallback).toBe(true);

      const recording = overlayReducer(done, { type: "RECORDING_START" });
      expect(recording.phase).toBe("recording");
      expect(recording.fallback).toBe(false);
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
      const recording = overlayReducer(initialState, { type: "RECORDING_START" });
      const result = overlayReducer(recording, { type: "FORMAT_DONE" });
      expect(result).toEqual(recording);
    });

    it("idle で RECORDING_START 以外のアクションは無視", () => {
      const result = overlayReducer(initialState, { type: "SET_TRANSCRIPT", transcript: "x" });
      expect(result).toEqual(initialState);
    });
  });

  describe("hideRequest の seq がインクリメントされる", () => {
    it("同一フロー内で連続する hideRequest は seq がインクリメントされる", () => {
      // RECORDING_START → STOP_TRANSCRIBING → TRANSCRIPT_EMPTY(silent) → seq=1
      const s1 = applyActions(initialState, [
        { type: "RECORDING_START" },
        { type: "STOP_TRANSCRIBING" },
        { type: "TRANSCRIPT_EMPTY", silent: true },
      ]);
      expect(s1.hideRequest!.seq).toBe(1);

      // 同じ state から RECORDING_FAILED → seq=2
      const s2 = overlayReducer(s1, { type: "RECORDING_FAILED", errorMsg: "err" });
      expect(s2.hideRequest!.seq).toBe(2);
    });
  });
});
