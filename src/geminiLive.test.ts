import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_MAX_DURATION_MS,
  geminiActivityEnd,
  geminiActivityStart,
  geminiAudioChunk,
  geminiSetup,
  parseGeminiMessage,
  scheduleGeminiMaxDuration,
} from "./geminiLive";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe("Gemini Live protocol", () => {
  it("setupはモデル、言語、VERBATIM、手動VADを指定する", () => {
    const setup = JSON.parse(geminiSetup("gemini-3.5-transcribe-live", "ja-JP")).setup;
    expect(setup.model).toBe("models/gemini-3.5-transcribe-live");
    expect(setup.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(setup.inputAudioTranscription).toEqual({
      languageCodes: ["ja-JP"],
      mode: "VERBATIM",
    });
    expect(setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
  });

  it("activity信号とPCM16メッセージを組み立てる", () => {
    expect(JSON.parse(geminiActivityStart()).realtimeInput.activityStart).toEqual({});
    expect(JSON.parse(geminiActivityEnd()).realtimeInput.activityEnd).toEqual({});
    const audio = JSON.parse(geminiAudioChunk(new Uint8Array([1, 2, 3, 4]).buffer))
      .realtimeInput.audio;
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(audio.data).toBe("AQIDBA==");
  });

  it("setup完了、暫定、確定を区別し、確定を優先する", () => {
    expect(parseGeminiMessage('{"setupComplete":{}}')).toEqual({ type: "setup-complete" });
    expect(parseGeminiMessage('{"serverContent":{"interimInputTranscription":{"text":"途中"}}}'))
      .toEqual({ type: "interim", text: "途中" });
    expect(parseGeminiMessage('{"serverContent":{"inputTranscription":{"text":"確定"}}}'))
      .toEqual({ type: "final", text: "確定" });
    expect(parseGeminiMessage('{"serverContent":{"interimInputTranscription":{"text":"旧"},"inputTranscription":{"text":"新"}}}'))
      .toEqual({ type: "final", text: "新" });
    expect(parseGeminiMessage("not json")).toEqual({ type: "ignored" });
  });

  it("PCM開始から9分で停止通知する", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    scheduleGeminiMaxDuration(onElapsed);

    vi.advanceTimersByTime(GEMINI_MAX_DURATION_MS - 1);
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  afterEach(() => vi.useRealTimers());
});
