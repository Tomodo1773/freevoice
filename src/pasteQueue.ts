export interface PasteQueueOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_PASTE_TIMEOUT_MS = 30_000;

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("貼り付けはキャンセルされました", "AbortError");
}

/**
 * 取消不能なpaste処理だけを直列化する独立レーン。
 * 呼び出しjobはcancel/timeoutで先に解放できるが、queue本体は実処理のsettleまで
 * 次のpasteを開始しないため、入力が混ざらない。
 */
export class PasteQueue {
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  run(
    operation: () => Promise<void>,
    options: PasteQueueOptions = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("PasteQueue is disposed"));
    }

    let timedOutBeforeStart = false;
    const execution = this.tail.then(async () => {
      if (timedOutBeforeStart) {
        throw new Error("貼り付け処理がタイムアウトしました");
      }
      if (options.signal?.aborted) throw abortError(options.signal);
      await operation();
    });
    // callerが先にcancel/timeoutしても、物理paste完了までは直列レーンを保持する。
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return this.waitForCaller(execution, options, () => {
      timedOutBeforeStart = true;
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }

  private waitForCaller(
    execution: Promise<void>,
    options: PasteQueueOptions,
    onTimeout: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(abortError(options.signal)));
      const timer = setTimeout(
        () => {
          onTimeout();
          finish(() => reject(new Error("貼り付け処理がタイムアウトしました")));
        },
        options.timeoutMs ?? DEFAULT_PASTE_TIMEOUT_MS,
      );

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      execution.then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      );
    });
  }
}
