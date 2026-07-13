export interface OverlayWindowPort {
  position(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
}

/**
 * オーバーレイの物理的なshow/hideを一列に並べ、最新世代だけを反映する。
 * 既に実行中のhideは取り消せないが、その後へ最新showを必ず連結するため、
 * 旧録音の遅延完了が新録音の表示状態を上書きしない。
 */
export class OverlayVisibilityController {
  private readonly port: OverlayWindowPort;
  private readonly onError?: (operation: string, error: unknown) => void;
  private readonly operationTimeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private currentToken = 0;
  private desiredVisible = false;
  private disposed = false;

  constructor(
    port: OverlayWindowPort,
    onError?: (operation: string, error: unknown) => void,
    operationTimeoutMs = 1_500,
  ) {
    this.port = port;
    this.onError = onError;
    this.operationTimeoutMs = operationTimeoutMs;
  }

  show(): number {
    if (this.disposed) return this.currentToken;
    const token = ++this.currentToken;
    this.desiredVisible = true;
    this.enqueue(async () => {
      try {
        await this.runBounded("position", token, () => this.port.position());
      } catch (error) {
        this.onError?.("position", error);
      }
      if (!this.isCurrentVisible(token)) return;
      try {
        await this.runBounded("show", token, () => this.port.show());
      } catch (error) {
        this.onError?.("show", error);
      }
    });
    return token;
  }

  hide(token: number): Promise<boolean> {
    if (this.disposed || token !== this.currentToken) {
      return Promise.resolve(false);
    }
    this.desiredVisible = false;
    return this.enqueue(async () => {
      if (
        this.disposed ||
        token !== this.currentToken ||
        this.desiredVisible
      ) {
        return false;
      }
      try {
        await this.runBounded("hide", token, () => this.port.hide());
        return true;
      } catch (error) {
        this.onError?.("hide", error);
        return false;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.desiredVisible = false;
    this.currentToken++;
  }

  /** テストと終了処理向け。現在queue済みの表示操作が終わるまで待つ。 */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private isCurrentVisible(token: number): boolean {
    return !this.disposed && this.desiredVisible && token === this.currentToken;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Tauri IPCを期限付きで待つ。期限後に元操作が完了して最新状態を上書きした場合は、
   * queue末尾へ補償show/hideを追加して最終状態を収束させる。
   */
  private runBounded(
    operation: "position" | "show" | "hide",
    token: number,
    start: () => Promise<void>,
  ): Promise<void> {
    const raw = start();
    let timedOut = false;
    void raw.then(
      () => {
        if (timedOut && operation !== "position" && !this.matches(operation, token)) {
          this.scheduleReconcile();
        }
      },
      () => {},
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        this.onError?.(
          operation,
          new Error(`${operation} timed out after ${this.operationTimeoutMs}ms`),
        );
        finish(resolve);
      }, this.operationTimeoutMs);
      raw.then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private matches(operation: "show" | "hide", token: number): boolean {
    return (
      token === this.currentToken &&
      (operation === "show" ? this.desiredVisible : !this.desiredVisible)
    );
  }

  private scheduleReconcile(): void {
    if (this.disposed) return;
    const token = this.currentToken;
    this.enqueue(async () => {
      if (this.disposed || token !== this.currentToken) return;
      const operation = this.desiredVisible ? "show" : "hide";
      try {
        await this.runBounded(operation, token, () => this.port[operation]());
      } catch (error) {
        this.onError?.(operation, error);
      }
    });
  }
}
