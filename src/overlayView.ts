import type { RecorderView } from "./recorder";

/**
 * オーバーレイの表示状態。制御（recorder）から切り離した「見た目専用」の状態機械。
 * done/empty/error は数秒表示して自動でフェードアウトする「トースト」として扱い、
 * その linger→fade→hide タイマーとウィンドウの表示/非表示をこのストアが一手に所有する。
 */
export type OverlayStatus =
  | "hidden"
  | "starting"
  | "recording"
  | "transcribing"
  | "formatting"
  | "done"
  | "empty"
  | "error";

export interface OverlayViewState {
  status: OverlayStatus;
  transcript: string;
  errorMsg: string;
  fallback: boolean;
  fallbackReason: string;
  fading: boolean;
}

export interface OverlayViewDeps {
  /** オーバーレイウィンドウを配置して表示する（投げっぱなしで良い）。 */
  showWindow: () => void;
  /** オーバーレイウィンドウを非表示にする。 */
  hideWindow: () => void;
}

/** フェードアウトの CSS トランジション時間。この経過後にウィンドウを隠す。 */
const FADE_MS = 400;

const HIDDEN_STATE: OverlayViewState = {
  status: "hidden",
  transcript: "",
  errorMsg: "",
  fallback: false,
  fallbackReason: "",
  fading: false,
};

export class OverlayView implements RecorderView {
  private state: OverlayViewState = HIDDEN_STATE;
  private readonly listeners = new Set<() => void>();
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlayViewDeps) {}

  getState = (): OverlayViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<OverlayViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearTimers(): void {
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.lingerTimer = null;
    this.fadeTimer = null;
  }

  /** ms 表示したのちフェード（FADE_MS）してウィンドウを隠し、hidden へ戻す。 */
  private scheduleHide(ms: number): void {
    this.clearTimers();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.set({ fading: true });
      this.fadeTimer = setTimeout(() => {
        this.fadeTimer = null;
        this.deps.hideWindow();
        this.state = HIDDEN_STATE;
        for (const listener of this.listeners) listener();
      }, FADE_MS);
    }, ms);
  }

  starting(): void {
    this.clearTimers();
    this.set({
      status: "starting",
      transcript: "",
      errorMsg: "",
      fallback: false,
      fallbackReason: "",
      fading: false,
    });
    this.deps.showWindow();
  }

  recording(): void {
    this.set({ status: "recording" });
  }

  transcript(text: string): void {
    if (
      this.state.status !== "recording" &&
      this.state.status !== "transcribing" &&
      this.state.status !== "formatting"
    ) {
      return;
    }
    this.set({ transcript: text });
  }

  transcribing(): void {
    this.set({ status: "transcribing" });
  }

  formatting(): void {
    this.set({ status: "formatting" });
  }

  done(fallback: boolean, fallbackReason: string): void {
    this.set({ status: "done", fallback, fallbackReason });
    this.scheduleHide(fallback ? 3000 : 1000);
  }

  empty(silent: boolean): void {
    this.set({ status: "empty", transcript: "音声が検出されませんでした" });
    this.scheduleHide(silent ? 1500 : 150);
  }

  error(message: string): void {
    this.set({ status: "error", errorMsg: message });
    this.scheduleHide(5000);
  }

  cancelled(): void {
    this.clearTimers();
    this.deps.hideWindow();
    this.set({ ...HIDDEN_STATE });
  }
}
