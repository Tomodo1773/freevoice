import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptionSession } from "./transcription";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const sdk = vi.hoisted(() => ({
  fromStreamInput: vi.fn(() => ({})),
}));

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class SpeechRecognizer {
    recognizing: unknown;
    recognized: unknown;
    canceled: unknown;
    sessionStopped: unknown;

    startContinuousRecognitionAsync(resolve: () => void): void {
      resolve();
    }

    stopContinuousRecognitionAsync(resolve: () => void): void {
      resolve();
    }

    close(): void {}
  }

  return {
    AudioConfig: { fromStreamInput: sdk.fromStreamInput },
    CancellationErrorCode: {},
    CancellationReason: {},
    Connection: { fromRecognizer: () => ({}) },
    PropertyId: { WebWorkerLoadType: "WebWorkerLoadType" },
    ResultReason: { RecognizedSpeech: 1, NoMatch: 2 },
    SpeechConfig: {
      fromEndpoint: () => ({
        speechRecognitionLanguage: "",
        setProperty: vi.fn(),
      }),
    },
    SpeechRecognizer,
  };
});

class FakeAudioContext {
  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => {} };
  }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 1,
      getByteFrequencyData: (values: Uint8Array) => values.fill(0),
    } as unknown as AnalyserNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("TranscriptionSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("Azure Speechへジョブ所有のMediaStreamを渡し、セッション側ではトラックを停止しない", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const stopTrack = vi.fn();
    const mediaStream = {
      active: true,
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const session = new TranscriptionSession();

    await session.start({
      provider: "azure-speech",
      endpoint: "",
      apiKey: "key",
      model: "",
      speechEndpoint: "https://example.cognitiveservices.azure.com",
      speechLanguage: "ja-JP",
      mediaStream,
    });

    expect(sdk.fromStreamInput).toHaveBeenCalledWith(mediaStream);
    await session.stop();
    expect(stopTrack).not.toHaveBeenCalled();
  });
});
