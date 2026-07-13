import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManagedRecordingAttempt,
  RecordingController,
  RecordingControllerOptions,
} from "./recordingController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

interface FakeContext {
  name: string;
}

class FakeAttempt implements ManagedRecordingAttempt<FakeContext> {
  readonly startDeferred = deferred<FakeContext>();
  readonly stopDeferred = deferred<string>();
  startCalls = 0;
  stopCalls = 0;
  disposeCalls = 0;
  signal?: AbortSignal;
  wasSilent = false;

  start(signal: AbortSignal): Promise<FakeContext> {
    this.startCalls++;
    this.signal = signal;
    return this.startDeferred.promise;
  }

  stop(): Promise<string> {
    this.stopCalls++;
    return this.stopDeferred.promise;
  }

  async dispose(): Promise<void> {
    this.disposeCalls++;
  }

  getAudioLevel(): number {
    return 0.25;
  }
}

function setup(overrides: Partial<RecordingControllerOptions<FakeContext>> = {}) {
  const attempts: FakeAttempt[] = [];
  const stopped = vi.fn();
  const onError = vi.fn();
  const onCancelled = vi.fn();
  const controller = new RecordingController<FakeContext>({
    createAttempt: () => {
      const attempt = new FakeAttempt();
      attempts.push(attempt);
      return attempt;
    },
    onStopped: stopped,
    onError,
    onCancelled,
    startTimeoutMs: 100,
    stopTimeoutMs: 100,
    ...overrides,
  });
  return { controller, attempts, stopped, onError, onCancelled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RecordingController", () => {
  it("holdのstarting中Releaseを予約し、ready直後に1回だけstopする", async () => {
    const { controller, attempts, stopped } = setup();
    controller.press("hold");
    controller.release();
    controller.release();
    expect(controller.getState()).toMatchObject({
      status: "starting",
      stopRequested: true,
    });

    attempts[0].startDeferred.resolve({ name: "app" });
    await flush();
    expect(controller.getState().status).toBe("stopping");
    expect(attempts[0].stopCalls).toBe(1);

    attempts[0].stopDeferred.resolve("text");
    await flush();
    expect(attempts[0].disposeCalls).toBe(1);
    expect(controller.getState().status).toBe("idle");
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ text: "text", context: { name: "app" } }),
    );
  });

  it("toggleでは偽Releaseを無視し、starting中の再Pressを停止予約にする", async () => {
    const { controller, attempts } = setup();
    controller.press("toggle");
    controller.release();
    expect(controller.getState().stopRequested).toBe(false);
    controller.press("toggle");
    expect(controller.getState().stopRequested).toBe(true);

    attempts[0].startDeferred.resolve({ name: "admin-app" });
    await flush();
    expect(attempts[0].stopCalls).toBe(1);
  });

  it("toggle録音中の再Pressで止まり、Releaseと重複してもstopは1回", async () => {
    const { controller, attempts } = setup();
    controller.press("toggle");
    attempts[0].startDeferred.resolve({ name: "app" });
    await flush();
    expect(controller.getState().status).toBe("recording");

    controller.press("toggle");
    controller.press("toggle");
    controller.release();
    expect(attempts[0].stopCalls).toBe(1);
  });

  it("開始timeoutで先に取得したhandleを即disposeし、late successも復活させない", async () => {
    vi.useFakeTimers();
    const { controller, attempts, onError } = setup();
    controller.press("hold");
    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(attempts[0].signal?.aborted).toBe(true);
    expect(attempts[0].disposeCalls).toBe(1);
    expect(controller.getState().status).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);

    attempts[0].startDeferred.resolve({ name: "late" });
    await flush();
    expect(controller.getState().status).toBe("error");
    expect(attempts[0].disposeCalls).toBe(1);
  });

  it("旧attemptのinterim/error callbackは新しいattemptを壊さない", async () => {
    const callbacks: Array<{
      interim(text: string): void;
      error(message: string): void;
    }> = [];
    const attempts: FakeAttempt[] = [];
    const controller = new RecordingController<FakeContext>({
      createAttempt: (input) => {
        callbacks.push({
          interim: input.onInterimResult,
          error: input.onRecognitionError,
        });
        const attempt = new FakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
    });

    controller.press("hold");
    controller.cancel();
    await flush();
    controller.press("hold");
    callbacks[0].interim("old");
    callbacks[0].error("old error");
    await flush();

    expect(controller.getState()).toMatchObject({
      status: "starting",
      attemptId: 2,
      interim: "",
      error: null,
    });
    expect(attempts[0].disposeCalls).toBe(1);
  });

  it("現在attemptの認識エラーはdispose完了後にerrorを通知する", async () => {
    const disposeDeferred = deferred<void>();
    let recognitionError!: (message: string) => void;
    const attempt = new FakeAttempt();
    attempt.dispose = vi.fn(() => disposeDeferred.promise);
    const onError = vi.fn();
    const controller = new RecordingController<FakeContext>({
      createAttempt: (input) => {
        recognitionError = input.onRecognitionError;
        return attempt;
      },
      onError,
    });
    controller.press("hold");
    attempt.startDeferred.resolve({ name: "app" });
    await flush();

    recognitionError("切断");
    await flush();
    expect(controller.getState().status).toBe("stopping");
    expect(onError).not.toHaveBeenCalled();

    disposeDeferred.resolve();
    await flush();
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: "切断",
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("cancelは開始途中のhandleをabort/disposeしてidleへ戻す", async () => {
    const { controller, attempts, onCancelled } = setup();
    controller.press("hold");
    controller.cancel();
    expect(controller.getState().status).toBe("stopping");
    await flush();

    expect(controller.getState().status).toBe("idle");
    expect(attempts[0].signal?.aborted).toBe(true);
    expect(attempts[0].disposeCalls).toBe(1);
    expect(onCancelled).toHaveBeenCalledWith(1);

    attempts[0].startDeferred.resolve({ name: "late" });
    await flush();
    expect(controller.getState().status).toBe("idle");
    expect(attempts[0].disposeCalls).toBe(1);
  });

  it("cancelのdispose完了までは次のattemptを開始しない", async () => {
    const disposeDeferred = deferred<void>();
    const attempts: FakeAttempt[] = [];
    const controller = new RecordingController<FakeContext>({
      createAttempt: () => {
        const attempt = new FakeAttempt();
        if (attempts.length === 0) {
          attempt.dispose = vi.fn(() => disposeDeferred.promise);
        }
        attempts.push(attempt);
        return attempt;
      },
    });

    controller.press("hold");
    controller.cancel();
    controller.press("hold");
    expect(controller.getState().status).toBe("stopping");
    expect(attempts).toHaveLength(1);

    disposeDeferred.resolve();
    await flush();
    expect(controller.getState().status).toBe("idle");
    controller.press("hold");
    expect(attempts).toHaveLength(2);
    expect(controller.getState()).toMatchObject({
      status: "starting",
      attemptId: 2,
    });
  });

  it("stop結果後のdispose待ち中にcancelしてもonStoppedを発火しない", async () => {
    const disposeDeferred = deferred<void>();
    const { controller, attempts, stopped, onCancelled } = setup();
    controller.press("hold");
    attempts[0].startDeferred.resolve({ name: "app" });
    await flush();

    attempts[0].dispose = vi.fn(() => disposeDeferred.promise);
    controller.release();
    attempts[0].stopDeferred.resolve("cancelled text");
    await flush();
    expect(controller.getState().status).toBe("stopping");

    controller.cancel();
    disposeDeferred.resolve();
    await flush();

    expect(stopped).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith(1);
    expect(controller.getState().status).toBe("idle");
  });

  it("stop timeoutはabort/disposeしてerrorへ進む", async () => {
    vi.useFakeTimers();
    const { controller, attempts, onError } = setup();
    controller.press("hold");
    attempts[0].startDeferred.resolve({ name: "app" });
    await flush();
    controller.release();

    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(attempts[0].signal?.aborted).toBe(true);
    expect(attempts[0].disposeCalls).toBe(1);
    expect(controller.getState().status).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
