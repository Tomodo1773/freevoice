export type RecordingMode = "hold" | "toggle";

export type RecordingControllerStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "error";

export interface RecordingControllerState {
  status: RecordingControllerStatus;
  attemptId: number | null;
  mode: RecordingMode | null;
  stopRequested: boolean;
  interim: string;
  error: string | null;
}

/**
 * 録音1回分の資源を所有するハンドル。
 *
 * createAttempt はこのハンドルを同期的に返す必要がある。これにより、start が
 * 応答しない場合でも Controller はマイク・認識器等を即座に dispose できる。
 * dispose は start/stop と並行しても安全かつ冪等でなければならない。
 */
export interface ManagedRecordingAttempt<TContext = unknown> {
  start(signal: AbortSignal): Promise<TContext>;
  stop(signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
  getAudioLevel(): number;
  readonly wasSilent: boolean;
}

export interface CreateRecordingAttemptInput {
  attemptId: number;
  onInterimResult(text: string): void;
  onRecognitionError(message: string): void;
}

export interface RecordingStopped<TContext = unknown> {
  attemptId: number;
  text: string;
  wasSilent: boolean;
  context: TContext;
}

export interface RecordingControllerError {
  attemptId: number;
  message: string;
  cause?: unknown;
}

export interface RecordingControllerOptions<TContext = unknown> {
  createAttempt(
    input: CreateRecordingAttemptInput,
  ): ManagedRecordingAttempt<TContext>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  onStopped?(result: RecordingStopped<TContext>): void;
  onError?(error: RecordingControllerError): void;
  onCancelled?(attemptId: number): void;
}

interface ActiveAttempt<TContext> {
  id: number;
  mode: RecordingMode;
  handle: ManagedRecordingAttempt<TContext>;
  abortController: AbortController;
  context?: TContext;
  startTimer: ReturnType<typeof setTimeout> | null;
  disposePromise: Promise<void> | null;
  stopStarted: boolean;
  failureStarted: boolean;
  cancelStarted: boolean;
}

const INITIAL_STATE: RecordingControllerState = {
  status: "idle",
  attemptId: null,
  mode: null,
  stopRequested: false,
  interim: "",
  error: null,
};

const DEFAULT_START_TIMEOUT_MS = 10_000;
// TranscriptionSession内部の停止・SDK close・AudioConfig回収の合計上限より長くする。
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "録音処理に失敗しました");
}

function timeoutError(operation: "start" | "stop"): Error {
  return new Error(
    operation === "start"
      ? "録音の開始がタイムアウトしました"
      : "録音の停止がタイムアウトしました",
  );
}

/**
 * 録音ライフサイクルと全録音資源の所有権を1か所に集約する Controller。
 * 公開イベントメソッドは待たずに返り、非同期完了は必ず attemptId で検証する。
 */
export class RecordingController<TContext = unknown> {
  private readonly options: RecordingControllerOptions<TContext>;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private state: RecordingControllerState = INITIAL_STATE;
  private active: ActiveAttempt<TContext> | null = null;
  private nextAttemptId = 0;
  private destroyed = false;
  private readonly subscribers = new Set<(
    state: RecordingControllerState,
  ) => void>();

  constructor(options: RecordingControllerOptions<TContext>) {
    this.options = options;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  getState(): RecordingControllerState {
    return this.state;
  }

  subscribe(listener: (state: RecordingControllerState) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  getAudioLevel(): number {
    try {
      return this.active?.handle.getAudioLevel() ?? 0;
    } catch {
      return 0;
    }
  }

  press(mode: RecordingMode): void {
    if (this.destroyed) return;

    if (this.state.status === "idle" || this.state.status === "error") {
      this.beginAttempt(mode);
      return;
    }

    const active = this.active;
    if (!active || active.mode !== "toggle") return;

    if (this.state.status === "starting") {
      this.updateState({ stopRequested: true });
    } else if (this.state.status === "recording") {
      this.beginStop(active);
    }
  }

  release(): void {
    if (this.destroyed) return;
    const active = this.active;
    if (!active || active.mode !== "hold") return;

    if (this.state.status === "starting") {
      this.updateState({ stopRequested: true });
    } else if (this.state.status === "recording") {
      this.beginStop(active);
    }
  }

  cancel(): void {
    if (this.destroyed) return;
    const active = this.active;
    if (!active) {
      this.replaceState(INITIAL_STATE);
      return;
    }
    if (active.cancelStarted) return;
    active.cancelStarted = true;
    this.clearStartTimer(active);
    active.abortController.abort();
    this.updateState({ status: "stopping", stopRequested: false });
    void this.finishCancel(active);
  }

  async dispose(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const active = this.detachActive();
    this.replaceState(INITIAL_STATE);
    if (active) {
      active.abortController.abort();
      await this.disposeAttempt(active);
    }
    this.subscribers.clear();
  }

  private beginAttempt(mode: RecordingMode): void {
    const id = ++this.nextAttemptId;
    let handle: ManagedRecordingAttempt<TContext>;

    try {
      handle = this.options.createAttempt({
        attemptId: id,
        onInterimResult: (text) => this.handleInterim(id, text),
        onRecognitionError: (message) =>
          this.handleRecognitionError(id, message),
      });
    } catch (error) {
      this.reportError(id, error);
      return;
    }

    const attempt: ActiveAttempt<TContext> = {
      id,
      mode,
      handle,
      abortController: new AbortController(),
      startTimer: null,
      disposePromise: null,
      stopStarted: false,
      failureStarted: false,
      cancelStarted: false,
    };
    this.active = attempt;
    this.replaceState({
      status: "starting",
      attemptId: id,
      mode,
      stopRequested: false,
      interim: "",
      error: null,
    });

    attempt.startTimer = setTimeout(
      () => this.handleStartTimeout(id),
      this.startTimeoutMs,
    );
    void this.runStart(attempt);
  }

  private async runStart(attempt: ActiveAttempt<TContext>): Promise<void> {
    try {
      const context = await attempt.handle.start(
        attempt.abortController.signal,
      );
      if (!this.isCurrent(attempt) || attempt.abortController.signal.aborted) {
        await this.disposeAttempt(attempt);
        return;
      }

      this.clearStartTimer(attempt);
      attempt.context = context;
      const shouldStop = this.state.stopRequested;
      this.updateState({ status: "recording" });
      if (shouldStop) this.beginStop(attempt);
    } catch (error) {
      if (!this.isCurrent(attempt)) {
        await this.disposeAttempt(attempt);
        return;
      }
      await this.failAttempt(attempt, error);
    }
  }

  private handleStartTimeout(id: number): void {
    const attempt = this.active;
    if (!attempt || attempt.id !== id || this.state.status !== "starting") {
      return;
    }
    void this.failAttempt(attempt, timeoutError("start"));
  }

  private handleInterim(id: number, text: string): void {
    const attempt = this.active;
    if (
      !attempt ||
      attempt.id !== id ||
      (this.state.status !== "starting" &&
        this.state.status !== "recording")
    ) {
      return;
    }
    this.updateState({ interim: text });
  }

  private handleRecognitionError(id: number, message: string): void {
    const attempt = this.active;
    if (!attempt || attempt.id !== id) return;
    if (
      this.state.status !== "starting" &&
      this.state.status !== "recording"
    ) {
      return;
    }
    void this.failAttempt(attempt, new Error(message));
  }

  private beginStop(attempt: ActiveAttempt<TContext>): void {
    if (
      !this.isCurrent(attempt) ||
      this.state.status !== "recording" ||
      attempt.stopStarted
    ) {
      return;
    }
    attempt.stopStarted = true;
    this.updateState({ status: "stopping", stopRequested: false });
    void this.runStop(attempt);
  }

  private async runStop(attempt: ActiveAttempt<TContext>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const stopPromise = attempt.handle.stop(attempt.abortController.signal);
      const text = await Promise.race([
        stopPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            attempt.abortController.abort();
            reject(timeoutError("stop"));
          }, this.stopTimeoutMs);
        }),
      ]);
      const wasSilent = attempt.handle.wasSilent;
      await this.disposeAttempt(attempt);
      // stop結果の取得後でも、dispose待ち中にcancelされることがある。
      // cleanup完了時点でも所有権を再検証し、取消済みattemptを後処理へ渡さない。
      if (
        !this.isCurrent(attempt) ||
        attempt.cancelStarted ||
        attempt.abortController.signal.aborted
      ) {
        return;
      }

      this.active = null;
      this.replaceState(INITIAL_STATE);
      this.callSafely(() =>
        this.options.onStopped?.({
          attemptId: attempt.id,
          text,
          wasSilent,
          context: attempt.context as TContext,
        }),
      );
    } catch (error) {
      if (attempt.cancelStarted) await this.disposeAttempt(attempt);
      else if (this.isCurrent(attempt)) await this.failAttempt(attempt, error);
      else await this.disposeAttempt(attempt);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async failAttempt(
    attempt: ActiveAttempt<TContext>,
    error: unknown,
  ): Promise<void> {
    if (!this.isCurrent(attempt) || attempt.failureStarted) return;
    attempt.failureStarted = true;
    this.clearStartTimer(attempt);
    attempt.abortController.abort();
    this.updateState({ status: "stopping", stopRequested: false });
    await this.disposeAttempt(attempt);
    if (!this.isCurrent(attempt) || attempt.cancelStarted) return;

    this.active = null;
    this.reportError(attempt.id, error);
  }

  private async finishCancel(attempt: ActiveAttempt<TContext>): Promise<void> {
    await this.disposeAttempt(attempt);
    if (!this.isCurrent(attempt) || !attempt.cancelStarted) return;
    this.active = null;
    this.replaceState(INITIAL_STATE);
    this.callSafely(() => this.options.onCancelled?.(attempt.id));
  }

  private reportError(attemptId: number, error: unknown): void {
    const message = errorMessage(error);
    this.replaceState({
      status: "error",
      attemptId,
      mode: null,
      stopRequested: false,
      interim: "",
      error: message,
    });
    this.callSafely(() =>
      this.options.onError?.({ attemptId, message, cause: error }),
    );
  }

  private detachActive(): ActiveAttempt<TContext> | null {
    const active = this.active;
    this.active = null;
    if (active) this.clearStartTimer(active);
    return active;
  }

  private clearStartTimer(attempt: ActiveAttempt<TContext>): void {
    if (attempt.startTimer !== null) {
      clearTimeout(attempt.startTimer);
      attempt.startTimer = null;
    }
  }

  private disposeAttempt(attempt: ActiveAttempt<TContext>): Promise<void> {
    this.clearStartTimer(attempt);
    if (!attempt.disposePromise) {
      attempt.disposePromise = Promise.resolve()
        .then(() => attempt.handle.dispose())
        .catch(() => {});
    }
    return attempt.disposePromise;
  }

  private isCurrent(attempt: ActiveAttempt<TContext>): boolean {
    return this.active === attempt && this.state.attemptId === attempt.id;
  }

  private updateState(patch: Partial<RecordingControllerState>): void {
    this.replaceState({ ...this.state, ...patch });
  }

  private replaceState(state: RecordingControllerState): void {
    this.state = Object.freeze({ ...state });
    for (const subscriber of this.subscribers) {
      this.callSafely(() => subscriber(this.state));
    }
  }

  private callSafely(callback: () => void): void {
    try {
      callback();
    } catch {
      // UI/通知側の例外で録音資源の解放を止めない。
    }
  }
}
