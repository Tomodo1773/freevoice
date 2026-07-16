import { formatError } from "./errors";
import { logInfo, logWarn, logError } from "./diagLog";
import type { AppSettings } from "./types";

/**
 * 録音制御の中核。従来の「キーエッジごとに新しい開始処理が並行して走り、各 await 地点で
 * 追い越しを自己申告して片付ける」設計をやめ、「アプリに録音ジョブは常に最大1つ」という
 * 単一所有モデルに置き換える。同時に走るジョブが無いので epoch/追い越し判定は不要になり、
 * リソース（マイク・ミュート・セッション）の解放は try/finally で構造的に保証される。
 */

/** 録音1回ぶんの内部フェーズ。キーエッジの意味づけに必要な最小限だけを持つ。 */
export type JobPhase = "starting" | "recording" | "processing";

/** 録音開始に必要な、設定と API キーを解決済みにまとめたもの。 */
export interface RecordingConfig {
  settings: AppSettings;
  apiKey: string;
  formatApiKey: string;
  langsmithApiKey: string;
  effectiveDeviceId: string;
}

/** 話題コンテキストのスコープに使う、録音開始時のフォアグラウンドウィンドウ。 */
export interface RecordingWindow {
  id: string;
  exe: string;
  title: string;
}

/** 認識セッションのうち、ジョブ制御が必要とする最小インターフェース（TranscriptionSession が満たす）。 */
export interface ActiveSession {
  stop(signal?: AbortSignal): Promise<string>;
  getAudioLevel(): number;
  readonly wasSilent: boolean;
}

/** セッション本体を await 前から所有するための開始ハンドル。 */
export interface PendingSession {
  session: ActiveSession;
  ready: Promise<void>;
}

export interface SessionCallbacks {
  onInterim: (text: string) => void;
  onError: (message: string) => void;
}

export interface FormatOutcome {
  text: string;
  fallback: boolean;
  fallbackReason: string;
}

export interface LogData {
  transcription: string;
  formatted: string;
  topic?: string;
  window?: { exe: string; title: string };
  error?: string;
}

/** 録音制御が呼ぶ表示側の窓口。制御と表示を分離し、表示の遅延/フェードは実装側に閉じ込める。 */
export interface RecorderView {
  /** 録音の見た目を出す（ウィンドウ表示＋「Recording」ピル）。開始直後に即呼ぶ。 */
  recording(): void;
  /** リアルタイム文字起こしの更新。 */
  transcript(text: string): void;
  transcribing(): void;
  formatting(): void;
  done(fallback: boolean, fallbackReason: string): void;
  /** 空結果（無音など）の終端表示。 */
  empty(silent: boolean): void;
  error(message: string): void;
  /** 処理中キャンセル。フェードせず即座に消す。 */
  cancelled(): void;
}

/** ジョブが依存する副作用。すべて注入することで、制御フローを DOM/Tauri 無しでテストできる。 */
export interface RecorderDeps {
  view: RecorderView;
  now: () => Date;
  /** マイク初期化とセッション確立に許す最大時間。超過で停滞とみなしエラーにする（旧 START_STALL の置換）。 */
  startTimeoutMs: number;
  beep: () => void;
  loadConfig: () => Promise<RecordingConfig>;
  resolveWindow: (config: RecordingConfig) => Promise<RecordingWindow | null>;
  acquireMic: (config: RecordingConfig) => Promise<MediaStream>;
  createSession: (
    mic: MediaStream,
    config: RecordingConfig,
    callbacks: SessionCallbacks
  ) => PendingSession;
  setMute: (mute: boolean) => Promise<void>;
  getContext: (windowId: string) => string | null;
  format: (
    raw: string,
    config: RecordingConfig,
    context: string | null,
    signal: AbortSignal
  ) => Promise<FormatOutcome>;
  paste: (text: string, config: RecordingConfig) => Promise<void>;
  saveLog: (config: RecordingConfig, now: Date, data: LogData) => Promise<void>;
  /** paste 後に非同期で話題コンテキストを更新（レイテンシに影響させないため投げっぱなし）。 */
  refreshTopic: (win: RecordingWindow, formatted: string, config: RecordingConfig) => void;
}

type StopSignal = { reason: "release" } | { reason: "recognition-error"; message: string };

interface JobLog {
  config: RecordingConfig;
  now: Date;
  data: LogData;
}

type JobResult =
  | { kind: "done"; fallback: boolean; fallbackReason: string; log: JobLog }
  | { kind: "empty"; silent: boolean; log?: JobLog }
  | { kind: "error"; message: string; log?: JobLog }
  | { kind: "cancelled"; log?: JobLog };

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** 詳細なエラーを短い定型メッセージに変換する（オーバーレイ表示用）。 */
export function toUserMessage(err: unknown): string {
  const msg = formatError(err);
  if (msg.startsWith("文字起こしAPI エラー")) return "文字起こしAPIでエラーが発生しました";
  if (msg.startsWith("後処理API エラー")) return "後処理APIでエラーが発生しました";
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "マイクの使用が許可されていません";
    if (err.name === "NotFoundError") return "マイクが見つかりません";
  }
  if (msg.includes("が未設定です") || msg.includes("形式で設定してください")) {
    return msg;
  }
  return "エラーが発生しました";
}

class StartTimeoutError extends Error {}

/** 開始処理全体で共有する絶対期限。各 await ごとに制限時間を足し直さない。 */
class StartDeadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) {
      void promise.catch(() => {});
      throw new StartTimeoutError("録音の開始がタイムアウトしました");
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StartTimeoutError("録音の開始がタイムアウトしました")),
        remaining
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** タイムアウト後に遅れて取得できたリソースも、その場で破棄する。 */
  async acquire<T>(promise: Promise<T>, dispose: (value: T) => void | Promise<void>): Promise<T> {
    try {
      return await this.wait(promise);
    } catch (e) {
      if (e instanceof StartTimeoutError) {
        void promise.then(
          (value) => Promise.resolve(dispose(value)).catch((disposeError) =>
            logWarn("recorder.deadline", "late resource cleanup failed", { error: disposeError })
          ),
          () => {}
        );
      }
      throw e;
    }
  }
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (e) {
      logWarn("recorder.cleanup", "media track cleanup failed", { error: e });
    }
  }
}

/**
 * 録音1回の一生。開始→録音→（キー解放で）文字起こし→整形→貼り付け、を上から下に読める
 * ひとつの流れとして持つ。マイク・ミュート・セッションの解放はいずれも finally に置き、
 * 成功・失敗・キャンセルのどの経路で抜けても必ず実行されるようにする。
 */
export class RecordingJob {
  phase: JobPhase = "starting";

  private readonly abort = new AbortController();
  private session: ActiveSession | null = null;
  private acceptsSessionCallbacks = true;

  private stopSettled = false;
  private stopResolve!: (signal: StopSignal) => void;
  /** キー解放または認識エラーで解決する。録音の「終端」を待つ唯一の地点。 */
  private readonly stopSignal = new Promise<StopSignal>((resolve) => {
    this.stopResolve = resolve;
  });

  constructor(private readonly deps: RecorderDeps) {}

  /** キー解放。録音を終わらせて文字起こしへ進める合図。開始処理中に来ても保持される。 */
  release(): void {
    this.settleStop({ reason: "release" });
  }

  /** 処理中（transcribing/formatting）の再押下＝キャンセル。 */
  cancel(): void {
    this.abort.abort();
  }

  getAudioLevel(): number {
    return this.session?.getAudioLevel() ?? 0;
  }

  private settleStop(signal: StopSignal): void {
    if (this.stopSettled) return;
    this.stopSettled = true;
    this.stopResolve(signal);
  }

  async run(): Promise<JobResult> {
    this.deps.view.recording();
    const deadline = new StartDeadline(this.deps.startTimeoutMs);
    try {
      this.deps.beep();
    } catch (e) {
      logWarn("recorder.run", "start beep failed", { error: e });
    }

    let config: RecordingConfig | null = null;
    let mic: MediaStream | null = null;
    try {
      config = await deadline.wait(this.deps.loadConfig());
      // 文脈スコープ用のフォアグラウンドウィンドウ取得は録音と並行させ、貼り付け直前に解決する。
      const windowPromise = config.settings.contextAwareFormatting
        ? this.deps.resolveWindow(config).catch((e) => {
            logWarn("recorder.run", "resolveWindow failed", { error: e });
            return null;
          })
        : Promise.resolve<RecordingWindow | null>(null);

      mic = await deadline.acquire(this.deps.acquireMic(config), stopMediaStream);

      const stop = await this.recordUntilStop(mic, config, deadline);
      if (stop.reason === "recognition-error") {
        return {
          kind: "error",
          message: stop.message,
          log: {
            config,
            now: this.deps.now(),
            data: { transcription: "", formatted: "", error: stop.message },
          },
        };
      }

      this.phase = "processing";
      return await this.process(config, windowPromise);
    } catch (e) {
      logError("recorder.run", "job failed", e, {
        ...(config ? { provider: config.settings.transcriptionProvider } : {}),
      });
      return {
        kind: "error",
        message: toUserMessage(e),
        ...(config
          ? {
              log: {
                config,
                now: this.deps.now(),
                data: { transcription: "", formatted: "", error: formatError(e) },
              },
            }
          : {}),
      };
    } finally {
      // 終端結果を返す前に、ジョブが所有するリソースをすべて解放する。
      const leftover = this.session;
      this.session = null;
      if (leftover) {
        await leftover.stop().catch((e: unknown) =>
          logWarn("recorder.run", "leftover session cleanup failed", { error: e })
        );
      }
      if (mic) stopMediaStream(mic);
    }
  }

  /**
   * ミュートを掛けてセッションを開始し、キー解放または認識エラーが来るまで待つ。
   * ミュート解除は「録音が終わった瞬間」に必ず行いたいので、この区間だけを finally で囲う
   * （処理中は既に解除済みで、システム音は塞がない）。
   * 開始失敗は呼び出し元へ例外として返し、停止シグナルだけを戻す。
   */
  private async recordUntilStop(
    mic: MediaStream,
    config: RecordingConfig,
    deadline: StartDeadline
  ): Promise<StopSignal> {
    logInfo("recorder.recordUntilStop", "start", {
      provider: config.settings.transcriptionProvider,
    });
    await this.deps.setMute(true).catch((e: unknown) =>
      logWarn("recorder.recordUntilStop", "set mute(true) failed", { error: e })
    );
    try {
      const pending = this.deps.createSession(mic, config, {
        onInterim: (text) => {
          if (this.acceptsSessionCallbacks) this.deps.view.transcript(text);
        },
        onError: (message) => {
          if (this.acceptsSessionCallbacks) {
            this.settleStop({ reason: "recognition-error", message });
          }
        },
      });
      // ready を待つ前からジョブが session を所有する。タイムアウト時も finally で停止できる。
      this.session = pending.session;
      await deadline.wait(pending.ready);
      this.phase = "recording";
      logInfo("recorder.recordUntilStop", "recording", {
        provider: config.settings.transcriptionProvider,
      });
      return await this.stopSignal;
    } finally {
      this.acceptsSessionCallbacks = false;
      await this.deps.setMute(false).catch((e: unknown) =>
        logWarn("recorder.recordUntilStop", "set mute(false) failed", { error: e })
      );
    }
  }

  /** 文字起こし→整形→貼り付け。キャンセル・空結果・エラーの分岐を1箇所に閉じる。 */
  private async process(
    config: RecordingConfig,
    windowPromise: Promise<RecordingWindow | null>
  ): Promise<JobResult> {
    const session = this.session!;
    this.session = null; // 所有権を取る。run の finally が二重 stop しないように。
    const signal = this.abort.signal;
    const now = this.deps.now();

    this.deps.view.transcribing();

    let raw = "";
    let formatted = "";
    let win: RecordingWindow | null = null;
    let context: string | null = null;
    const makeLog = (includeError = false, error?: unknown): JobLog => ({
      config,
      now,
      data: {
        transcription: raw,
        formatted,
        ...(win ? { window: { exe: win.exe, title: win.title } } : {}),
        ...(context ? { topic: context } : {}),
        ...(includeError ? { error: formatError(error) } : {}),
      },
    });
    try {
      [raw, win] = await Promise.all([session.stop(signal), windowPromise]);
      context = win ? this.deps.getContext(win.id) : null;
      if (!raw.trim()) {
        const log = session.wasSilent ? logInfo : logWarn;
        log("recorder.process", "empty transcript", {
          silent: session.wasSilent,
          provider: config.settings.transcriptionProvider,
        });
        return { kind: "empty", silent: session.wasSilent };
      }

      logInfo("recorder.process", "transcript received, starting format", {
        provider: config.settings.transcriptionProvider,
        transcriptLen: raw.length,
        hasContext: !!context,
      });
      this.deps.view.transcript(raw);
      this.deps.view.formatting();

      const outcome = await this.deps.format(raw, config, context, signal);
      formatted = outcome.text;
      logInfo("recorder.process", "format complete", {
        fallback: outcome.fallback,
        fallbackReason: outcome.fallbackReason,
        formattedLen: formatted.length,
      });

      await this.deps.paste(formatted, config);
      logInfo("recorder.process", "pasted", {
        method: config.settings.inputMethod,
        textLen: formatted.length,
      });
      // fallback（整形失敗で生テキスト）時は誤りを取り込まないよう蒸留しない。
      if (win && !outcome.fallback) {
        this.deps.refreshTopic(win, formatted, config);
      }
      return {
        kind: "done",
        fallback: outcome.fallback,
        fallbackReason: outcome.fallbackReason,
        log: makeLog(),
      };
    } catch (e) {
      if (isAbortError(e)) {
        logInfo("recorder.process", "cancelled by user (re-trigger during processing)", {
          hadTranscript: !!raw,
          transcriptLen: raw.length,
          formatted: formatted !== "",
        });
        return {
          kind: "cancelled",
          ...(raw ? { log: makeLog() } : {}),
        };
      }
      logError("recorder.process", "process failed", e);
      const hasError = formatted === "";
      return {
        kind: "error",
        message: toUserMessage(e),
        ...(raw || hasError ? { log: makeLog(hasError, e) } : {}),
      };
    }
  }
}

/**
 * 受付係。アプリ全体でジョブは常に最大1つ。キーの押下/解放は「判断」せず、この一点に集約する。
 * - 押下: ジョブが無ければ録音開始。処理中なら中止。開始処理中/録音中なら無視。
 * - 解放: 走っているジョブに解放を伝えるだけ。
 * これにより「同時に走る開始処理」自体が存在しなくなり、追い越し判定が構造的に不要になる。
 */
export class RecorderController {
  private job: RecordingJob | null = null;

  constructor(private readonly deps: RecorderDeps) {}

  keyDown(): void {
    const job = this.job;
    if (job) {
      if (job.phase === "processing") {
        logInfo("recorder.keyDown", "cancel requested: aborting in-flight processing");
        job.cancel();
      } else {
        logWarn("recorder.keyDown", "start ignored: recording already active", {
          phase: job.phase,
        });
      }
      return;
    }
    const newJob = new RecordingJob(this.deps);
    this.job = newJob;
    void newJob.run().then(
      (result) => this.finish(newJob, result),
      (e) => {
        logError("recorder.keyDown", "unexpected job failure", e);
        this.finish(newJob, { kind: "error", message: toUserMessage(e) });
      }
    );
  }

  keyUp(): void {
    if (!this.job) {
      logInfo("recorder.keyUp", "stop ignored: no active job");
      return;
    }
    this.job.release();
  }

  getAudioLevel(): number {
    return this.job?.getAudioLevel() ?? 0;
  }

  get isRecording(): boolean {
    return this.job?.phase === "recording";
  }

  private finish(job: RecordingJob, result: JobResult): void {
    if (this.job !== job) return;

    // 終端表示より先に所有権を解放し、表示中の次回 keyDown を新しい録音として受け付ける。
    this.job = null;
    switch (result.kind) {
      case "done":
        this.deps.view.done(result.fallback, result.fallbackReason);
        break;
      case "empty":
        this.deps.view.empty(result.silent);
        break;
      case "error":
        this.deps.view.error(result.message);
        break;
      case "cancelled":
        this.deps.view.cancelled();
        break;
    }

    if (result.log) {
      const { config, now, data } = result.log;
      void this.deps.saveLog(config, now, data).catch((e) =>
        logWarn("recorder.finish", "saveLog failed", { error: e })
      );
    }
  }
}
