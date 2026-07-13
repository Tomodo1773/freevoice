export interface PostprocessJobContext {
  readonly jobId: number;
  readonly signal: AbortSignal;
  /**
   * 貼り付けや UI 更新など、取り消せない副作用の直前に呼ぶ。
   * この job が既に取り消された、または新しい job に置き換わった場合は
   * AbortError を投げる。
   */
  checkpoint(): void;
}

export type PostprocessJobExecutor<TResult> = (
  context: PostprocessJobContext,
) => TResult | Promise<TResult>;

export interface PostprocessJobCallbacks<TResult> {
  onCompleted?: (result: TResult, jobId: number) => void;
  onFailed?: (error: unknown, jobId: number) => void;
  onCancelled?: (jobId: number) => void;
}

export type PostprocessJobState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly jobId: number }
  | { readonly status: "disposed" };

interface ActiveJob {
  readonly jobId: number;
  readonly abortController: AbortController;
  readonly checkpoint: () => void;
  cancelNotified: boolean;
}

function abortError(message = "Postprocess job was cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 整形から貼り付けまでの非同期処理を、一度に一つの job として所有する。
 *
 * AbortSignal は協調的な中断に使い、checkpoint は旧 job による副作用を
 * 防ぐために使う。executor が AbortSignal を無視して完了しても、旧 job の
 * 完了 callback は発火しない。
 */
export class PostprocessJobController<TResult = void> {
  private readonly callbacks: PostprocessJobCallbacks<TResult>;
  private activeJob: ActiveJob | null = null;
  private nextJobId = 0;
  private disposed = false;

  constructor(callbacks: PostprocessJobCallbacks<TResult> = {}) {
    this.callbacks = callbacks;
  }

  getState(): PostprocessJobState {
    if (this.disposed) return { status: "disposed" };
    if (this.activeJob) return { status: "running", jobId: this.activeJob.jobId };
    return { status: "idle" };
  }

  isRunning(): boolean {
    return this.activeJob !== null;
  }

  start(executor: PostprocessJobExecutor<TResult>): Promise<TResult> {
    if (this.disposed) {
      throw new Error("PostprocessJobController is disposed");
    }
    if (this.activeJob) {
      throw new Error("A postprocess job is already running");
    }

    const jobId = ++this.nextJobId;
    const abortController = new AbortController();
    const job: ActiveJob = {
      jobId,
      abortController,
      cancelNotified: false,
      checkpoint: () => {
        if (
          abortController.signal.aborted ||
          this.disposed ||
          this.activeJob !== job
        ) {
          throw abortError();
        }
      },
    };
    this.activeJob = job;

    return this.run(job, executor);
  }

  /** 現在の job を取り消す。既に停止済みなら false を返す。 */
  cancel(): boolean {
    const job = this.activeJob;
    if (!job || job.abortController.signal.aborted) return false;

    this.activeJob = null;
    job.abortController.abort(abortError());
    this.notifyCancelled(job);
    return true;
  }

  /** Controller を恒久的に停止し、実行中の job があれば取り消す。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private async run(
    job: ActiveJob,
    executor: PostprocessJobExecutor<TResult>,
  ): Promise<TResult> {
    const context: PostprocessJobContext = {
      jobId: job.jobId,
      signal: job.abortController.signal,
      checkpoint: job.checkpoint,
    };

    // executor を次の microtask で始め、start() 直後の cancel() も実行前に反映する。
    const execution = Promise.resolve().then(() => {
      job.checkpoint();
      return executor(context);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      job.abortController.signal.addEventListener(
        "abort",
        () => reject(abortError()),
        { once: true },
      );
    });

    try {
      const result = await Promise.race([execution, cancelled]);
      // executor が signal を無視しても、完了通知の前に世代を再確認する。
      job.checkpoint();
      this.activeJob = null;
      this.callbacks.onCompleted?.(result, job.jobId);
      return result;
    } catch (error) {
      const cancelled = isAbortError(error) || job.abortController.signal.aborted;
      if (this.activeJob === job) {
        this.activeJob = null;
        if (cancelled) this.notifyCancelled(job);
        else this.callbacks.onFailed?.(error, job.jobId);
      }
      if (cancelled) throw abortError();
      throw error;
    }
  }

  private notifyCancelled(job: ActiveJob): void {
    if (job.cancelNotified) return;
    job.cancelNotified = true;
    this.callbacks.onCancelled?.(job.jobId);
  }
}
