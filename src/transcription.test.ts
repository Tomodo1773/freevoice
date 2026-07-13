import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptionSession } from "./transcription";

const validParams = {
  provider: "azure-openai" as const,
  endpoint: "https://example.openai.azure.com",
  apiKey: "key",
  model: "whisper",
  speechEndpoint: "",
  speechLanguage: "ja-JP",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("TranscriptionSession lifecycle", () => {
  it("disposeは開始前から冪等で、破棄後にstartできない", async () => {
    const session = new TranscriptionSession();

    await Promise.all([session.dispose(), session.dispose()]);

    await expect(session.start(validParams)).rejects.toThrow(
      "録音セッションは一度だけ開始できます",
    );
  });

  it("abort済みsignalではマイク取得前に終了し、後から再開できない", async () => {
    const session = new TranscriptionSession();
    const controller = new AbortController();
    controller.abort(new DOMException("test abort", "AbortError"));

    await expect(session.start(validParams, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(session.start(validParams)).rejects.toThrow(
      "録音セッションは一度だけ開始できます",
    );
  });

  it("dispose後にgetUserMediaが遅れて成功してもtrackを即座に解放する", async () => {
    const media = deferred<MediaStream>();
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => media.promise) },
    });
    const session = new TranscriptionSession();
    const startResult = session.start(validParams).catch((error) => error);

    await session.dispose();
    const startError = await startResult;
    expect(startError).toMatchObject({ name: "AbortError" });
    expect(stop).not.toHaveBeenCalled();

    media.resolve({
      getTracks: () => [{ stop }],
    } as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
