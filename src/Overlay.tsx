import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CaptureAttempt, type CaptureContext } from "./captureAttempt";
import { postprocessWithRetry } from "./postprocess";
import { PostprocessJobController } from "./postprocessJobController";
import { PasteQueue } from "./pasteQueue";
import {
  RecordingController,
  type RecordingStopped,
} from "./recordingController";
import { getContext, refreshContext } from "./windowContext";
import { sendLlmSpan } from "./langsmithTrace";
import { loadSettings } from "./useSettings";
import { migrateFormatApiKey } from "./apiKeyStore";
import { createOverlayStore } from "./overlayReducer";
import { OverlayVisibilityController } from "./overlayVisibilityController";
import { formatError } from "./errors";
import { logInfo, logWarn, logError, setLogPhaseSource } from "./diagLog";

function playStartBeep(): void {
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, ctx.currentTime);
  gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.08);
  oscillator.onended = () => ctx.close();
}

/** 詳細なエラーを短い定型メッセージに変換する（オーバーレイ表示用） */
function toUserMessage(err: unknown): string {
  const msg = formatError(err);
  if (msg.startsWith("文字起こしAPI エラー")) return "文字起こしAPIでエラーが発生しました";
  if (msg.startsWith("後処理API エラー")) return "後処理APIでエラーが発生しました";
  if (msg.includes("録音の開始がタイムアウト") || msg.includes("認識開始がタイムアウト")) {
    return "音声認識を開始できませんでした";
  }
  if (msg.includes("録音の停止がタイムアウト") || msg.includes("認識停止がタイムアウト")) {
    return "音声認識を停止できませんでした";
  }
  if (msg.includes("貼り付け処理がタイムアウト")) {
    return "貼り付け処理がタイムアウトしました";
  }
  // マイク権限・デバイス系エラー
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "マイクの使用が許可されていません";
    if (err.name === "NotFoundError") return "マイクが見つかりません";
  }
  // 設定バリデーション系のメッセージはそのまま（短いため）
  if (
    msg.includes("が未設定です") ||
    msg.includes("形式で設定してください")
  ) {
    return msg;
  }
  return "エラーが発生しました";
}

interface LogData {
  transcription: string;
  formatted: string;
  topic?: string;
  window?: { exe: string; title: string };
  error?: string;
}

async function saveLogEntry(
  logFolder: string,
  now: Date,
  data: LogData
): Promise<void> {
  const isoTimestamp = now.toISOString();
  const datePart = isoTimestamp.slice(0, 10); // YYYY-MM-DD
  const timePart = isoTimestamp.slice(11).replace(/:/g, "-").replace(/\./g, "-"); // HH-MM-SS-mmmZ
  const folder = `${logFolder}/${datePart}`;
  const filename = `freevoice-${timePart}.json`;
  const content = JSON.stringify({ timestamp: isoTimestamp, ...data }, null, 2);
  await invoke("save_log", { folder, filename, content });
}

async function trySaveLog(
  configuredFolder: string,
  now: Date,
  data: LogData
): Promise<void> {
  try {
    const logFolder = configuredFolder || await invoke<string>("get_app_log_dir");
    await saveLogEntry(logFolder, now, data);
  } catch (logErr) {
    logError("overlay.saveLog", "save_log failed", logErr);
  }
}

export default function Overlay() {
  // OverlayStore は表示専用。録音可否と資源所有は RecordingController が単独で判断する。
  const storeRef = useRef<ReturnType<typeof createOverlayStore> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createOverlayStore();
    setLogPhaseSource(() => storeRef.current!.getState().phase);
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const dispatch = store.dispatch;
  const {
    phase,
    captureMode,
    stopRequested,
    transcript,
    errorMsg,
    fallback,
    fallbackReason,
    fading,
    hideRequest,
  } = state;

  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);

  const realtimeTextRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);
  const stoppedHandlerRef = useRef<(result: RecordingStopped<CaptureContext>) => void>(() => {});
  const recordingErrorHandlerRef = useRef<(message: string, cause?: unknown) => void>(() => {});
  const recordingCancelledHandlerRef = useRef<() => void>(() => {});

  const recordingControllerRef = useRef<RecordingController<CaptureContext> | null>(null);
  if (!recordingControllerRef.current) {
    recordingControllerRef.current = new RecordingController<CaptureContext>({
      createAttempt: (input) => new CaptureAttempt(input),
      onStopped: (result) => stoppedHandlerRef.current(result),
      onError: ({ message, cause }) => recordingErrorHandlerRef.current(message, cause),
      onCancelled: () => recordingCancelledHandlerRef.current(),
    });
  }
  const recordingController = recordingControllerRef.current;

  const postprocessControllerRef = useRef<PostprocessJobController<void> | null>(null);
  if (!postprocessControllerRef.current) {
    postprocessControllerRef.current = new PostprocessJobController<void>();
  }
  const postprocessController = postprocessControllerRef.current;

  const pasteQueueRef = useRef<PasteQueue | null>(null);
  if (!pasteQueueRef.current) pasteQueueRef.current = new PasteQueue();
  const pasteQueue = pasteQueueRef.current;

  const visibilityControllerRef = useRef<OverlayVisibilityController | null>(null);
  if (!visibilityControllerRef.current) {
    visibilityControllerRef.current = new OverlayVisibilityController(
      {
        position: () => invoke("position_overlay"),
        show: () => getCurrentWebviewWindow().show(),
        hide: () => getCurrentWebviewWindow().hide(),
      },
      (operation, error) =>
        logWarn("overlay.visibility", `${operation} failed`, { error }),
    );
  }
  const visibilityController = visibilityControllerRef.current;
  const visibilityTokenRef = useRef<number | null>(null);

  const hideOwnedOverlay = async (token: number | null): Promise<void> => {
    if (token === null) return;
    const hidden = await visibilityController.hide(token);
    if (hidden && visibilityTokenRef.current === token) {
      visibilityTokenRef.current = null;
    }
  };

  useEffect(() => {
    logInfo("overlay.init", "overlay window initialized");
    migrateFormatApiKey().catch((e) =>
      logWarn("overlay.init", "migrateFormatApiKey failed", { error: e })
    );
    // 古いログフォルダを起動時にクリーンアップ
    (async () => {
      try {
        const settings = loadSettings();
        const logFolder = settings.logFolder.trim() || await invoke<string>("get_app_log_dir");
        await invoke("cleanup_old_logs", { folder: logFolder, keepDays: 30 });
      } catch (e) {
        logError("overlay.init", "cleanup_old_logs failed", e);
      }
    })();

    invoke("set_click_through").catch((e) =>
      logWarn("overlay.init", "set_click_through failed", { error: e })
    );
    // In React StrictMode (dev), effects can mount/unmount twice.
    // Ensure we don't leak duplicate global event listeners.
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const unlisteners = await Promise.all([
        listen<{ toggleStop?: boolean }>("recording-start", (event) =>
          handleShortcutPressed(event.payload?.toggleStop === true)
        ),
        listen("recording-stop", () => recordingController.release()),
        // トレイ「ログを開く」から発火。設定済みフォルダ（空ならデフォルト）を Rust で開く
        listen("open-log-folder", () => {
          const logFolder = loadSettings().logFolder.trim();
          invoke("open_log_folder", { folder: logFolder }).catch((e) =>
            logError("overlay.openLogFolder", "open_log_folder failed", e)
          );
        }),
      ]);
      const unlistenAll = () => unlisteners.forEach((u) => u());

      if (disposed) {
        unlistenAll();
        return;
      }
      cleanup = unlistenAll;
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => recordingController.subscribe((capture) => {
    if (
      (capture.status === "starting" ||
        capture.status === "recording" ||
        capture.status === "stopping") &&
      capture.attemptId !== null &&
      capture.mode !== null
    ) {
      dispatch({
        type: "CAPTURE_STATE",
        status: capture.status,
        attemptId: capture.attemptId,
        mode: capture.mode,
        stopRequested: capture.stopRequested,
        interim: capture.interim,
      });
    }
  }), []);

  useEffect(() => {
    const disposeControllers = () => {
      postprocessController.dispose();
      pasteQueue.dispose();
      visibilityController.dispose();
      void recordingController.dispose();
    };
    window.addEventListener("beforeunload", disposeControllers);
    return () => window.removeEventListener("beforeunload", disposeControllers);
  }, []);

  // VUメーター更新ループ
  useEffect(() => {
    const tick = () => {
      if (phase === "recording") {
        const lvl = recordingController.getAudioLevel();
        setAudioLevel(lvl);

        const now = Date.now();
        if (lvl < 0.01) {
          silentSinceRef.current ??= now;
          setSilentWarn(now - silentSinceRef.current > 2000);
        } else {
          silentSinceRef.current = null;
          setSilentWarn(false);
        }
      } else {
        setAudioLevel(0);
        setSilentWarn(false);
        silentSinceRef.current = null;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [phase === "recording"]);

  // リアルタイムテキスト末尾を常に表示
  useEffect(() => {
    if (realtimeTextRef.current) {
      realtimeTextRef.current.scrollTop = realtimeTextRef.current.scrollHeight;
    }
  }, [transcript]);

  // hideRequest を監視してフェード開始タイマーを起動
  useEffect(() => {
    if (!hideRequest) return;

    const timer = setTimeout(() => {
      dispatch({ type: "BEGIN_FADE" });
    }, hideRequest.ms);

    return () => clearTimeout(timer);
  }, [hideRequest?.seq]);

  // fading 開始後、400ms でウィンドウを非表示にしてリセット
  useEffect(() => {
    if (!fading) return;
    // timer作成時のownerを固定し、後から始まった録音のtokenをhideしない。
    const visibilityToken = visibilityTokenRef.current;

    const timer = setTimeout(async () => {
      await hideOwnedOverlay(visibilityToken);
      dispatch({ type: "FADE_DONE" });
    }, 400);

    return () => clearTimeout(timer);
  }, [fading]);

  const handleShortcutPressed = (requiresToggleStop: boolean) => {
    const capture = recordingController.getState();

    if (capture.status === "stopping") {
      logInfo("overlay.shortcut", "cancelling capture cleanup");
      recordingController.cancel();
      return;
    }
    if (postprocessController.isRunning()) {
      logInfo("overlay.shortcut", "cancelling postprocess job");
      postprocessController.cancel();
      return;
    }

    const previousAttemptId = capture.attemptId;
    recordingController.press(requiresToggleStop ? "toggle" : "hold");
    const next = recordingController.getState();
    if (next.status === "starting" && next.attemptId !== previousAttemptId) {
      visibilityTokenRef.current = visibilityController.show();
      try {
        playStartBeep();
      } catch (error) {
        logWarn("overlay.shortcut", "start beep failed", { error });
      }
    }
  };

  const handleStoppedRecording = (result: RecordingStopped<CaptureContext>): void => {
    const { text: raw, wasSilent, context } = result;
    const { settings, formatApiKey, langsmithApiKey, startedAt, windowPromise } = context;

    if (!raw.trim()) {
      const logEmpty = wasSilent ? logInfo : logWarn;
      logEmpty("overlay.capture", "empty transcript", {
        silent: wasSilent,
        provider: settings.transcriptionProvider,
      });
      dispatch({ type: "TRANSCRIPT_EMPTY", silent: wasSilent });
      return;
    }

    const now = startedAt;
    const jobVisibilityToken = visibilityTokenRef.current;
    void postprocessController.start(async (job) => {
      let formattedText = "";
      let jobError: unknown = null;
      let win: Awaited<NonNullable<CaptureContext["windowPromise"]>> = null;
      let injectedContext: string | null = null;

      try {
        win = settings.contextAwareFormatting && windowPromise
          ? await windowPromise
          : null;
        job.checkpoint();
        injectedContext = win ? getContext(win.id) : null;

        logInfo("overlay.postprocess", "transcript received, starting format", {
          provider: settings.transcriptionProvider,
          transcriptLen: raw.length,
          hasContext: !!injectedContext,
        });
        job.checkpoint();
        dispatch({ type: "TRANSCRIPT_READY", transcript: raw });

        const formatModel = settings.formatProvider === "openai"
          ? settings.openaiFormatModel
          : settings.azureFormatModel;
        const formatStartMs = Date.now();
        const {
          text: formatted,
          fallback,
          fallbackReason,
          usage: formatUsage,
          model: formatResponseModel,
          errorStatus: formatErrorStatus,
          messages: formatMessages,
        } = await postprocessWithRetry(
          raw,
          settings.formatProvider,
          settings.formatEndpoint,
          formatApiKey,
          formatModel,
          settings.postprocessPrompt,
          settings.reasoningEffort,
          injectedContext ?? undefined,
          job.signal,
        );
        job.checkpoint();

        const formatEndMs = Date.now();
        formattedText = formatted;
        logInfo("overlay.postprocess", "format complete", {
          fallback,
          fallbackReason,
          formattedLen: formatted.length,
          durationMs: formatEndMs - formatStartMs,
        });

        const langsmithConfig = settings.langsmithEnabled
          ? {
              region: settings.langsmithRegion,
              project: settings.langsmithProject,
              apiKey: langsmithApiKey,
              includeContent: settings.langsmithIncludeContent,
            } as const
          : undefined;

        if (langsmithConfig) {
          job.checkpoint();
          void sendLlmSpan({
            spanName: "format",
            ...langsmithConfig,
            provider: settings.formatProvider,
            requestModel: formatModel,
            responseModel: formatResponseModel,
            messages: formatMessages,
            completion: fallback ? undefined : formatted,
            reasoningEffort: settings.reasoningEffort,
            usage: formatUsage,
            startTimeMs: formatStartMs,
            endTimeMs: formatEndMs,
            error: fallback
              ? {
                  message: fallbackReason ?? "format fallback",
                  status: formatErrorStatus,
                }
              : undefined,
          });
        }

        // pasteは取り消せないため、必ず直前にjobの世代とcancel状態を再確認する。
        job.checkpoint();
        await pasteQueue.run(
          async () => {
            // 待機中にcancelされたjobは、pasteレーンの先頭へ来ても実行しない。
            job.checkpoint();
            await invoke("paste_text", {
              text: formatted,
              method: settings.inputMethod,
            });
          },
          { signal: job.signal },
        );
        job.checkpoint();
        logInfo("overlay.postprocess", "pasted", {
          method: settings.inputMethod,
          textLen: formatted.length,
        });
        dispatch({ type: "FORMAT_DONE", fallback, fallbackReason });

        if (win && !fallback) {
          job.checkpoint();
          void refreshContext(
            win.id,
            win.exe,
            win.title,
            formatted,
            {
              formatProvider: settings.formatProvider,
              endpoint: settings.formatEndpoint,
              apiKey: formatApiKey,
              model: formatModel,
              reasoningEffort: settings.reasoningEffort,
            },
            langsmithConfig,
          );
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          jobError = error;
        }
        throw error;
      } finally {
        const hasError = jobError !== null && formattedText === "";
        if (raw || hasError) {
          // ログ保存はbest-effort。貼り付け済みjobの所有権を占有させない。
          void trySaveLog(settings.logFolder.trim(), now, {
            transcription: raw,
            formatted: formattedText,
            ...(win ? { window: { exe: win.exe, title: win.title } } : {}),
            ...(injectedContext ? { topic: injectedContext } : {}),
            ...(hasError ? { error: formatError(jobError) } : {}),
          });
        }
      }
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        logInfo("overlay.postprocess", "cancelled by user", {
          transcriptLen: raw.length,
        });
        dispatch({ type: "POSTPROCESS_CANCELLED" });
        void hideOwnedOverlay(jobVisibilityToken);
        return;
      }
      logError("overlay.postprocess", "postprocess failed", error);
      dispatch({ type: "POSTPROCESS_ERROR", errorMsg: toUserMessage(error) });
    });
  };

  stoppedHandlerRef.current = handleStoppedRecording;
  recordingErrorHandlerRef.current = (message, cause) => {
    const error = cause ?? new Error(message);
    logError("overlay.capture", "capture failed", error);
    dispatch({ type: "CAPTURE_FAILED", errorMsg: toUserMessage(error) });
    void trySaveLog(loadSettings().logFolder.trim(), new Date(), {
      transcription: "",
      formatted: "",
      error: formatError(error),
    });
  };
  recordingCancelledHandlerRef.current = () => {
    logInfo("overlay.capture", "capture cancelled after cleanup");
    const captureVisibilityToken = visibilityTokenRef.current;
    dispatch({ type: "CAPTURE_CANCELLED" });
    void hideOwnedOverlay(captureVisibilityToken);
  };

  // nospeech（無音終端）は表示上は recording と同じ「listening」系で扱い、現行の見た目を温存する。
  const isRecordingLike = phase === "starting" || phase === "recording" || phase === "nospeech";

  // phase から既存 CSS クラス名へのマッピング（CSS変更不要にする）
  const cssStatus =
    (isRecordingLike || phase === "idle") ? "listening" : phase;

  const pillClass = [
    "overlay-pill",
    `status-${cssStatus}`,
    fading ? "fading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const icon =
    isRecordingLike ? "●" :
    (phase === "transcribing" || phase === "formatting") ? <span className="spinner">◌</span> :
    phase === "done" ? "✓" :
    phase === "error" ? "!" :
    null;

  const statusLabel =
    phase === "starting"
      ? "Starting"
      : isRecordingLike
      ? "Recording"
      : phase === "transcribing"
      ? "Transcribing"
      : phase === "formatting"
      ? "Formatting"
      : phase === "done"
      ? "Done"
      : phase === "error"
      ? "Error"
      : "";

  const text =
    phase === "starting"
      ? (stopRequested
        ? "Stopping..."
        : captureMode === "toggle"
        ? "Starting... Press shortcut again to stop"
        : "Starting...")
      : phase === "recording"
      ? transcript || (captureMode === "toggle" ? "Press shortcut again to stop" : silentWarn ? "Microphone input may be silent" : "Listening...")
      : phase === "nospeech"
      ? transcript
      : phase === "transcribing"
      ? "Transcribing..."
      : phase === "formatting"
      ? "Formatting..."
      : phase === "done"
      ? (fallback ? `スキップ: ${fallbackReason || "エラー"}` : "Completed")
      : errorMsg;

  return (
    <div className="overlay-wrapper">
      <div className={pillClass}>
        <span className="overlay-glow" aria-hidden="true" />
        <div className="overlay-leading">
          <span className="overlay-icon">{icon}</span>
          <span className="overlay-status">{statusLabel}</span>
        </div>
        <div className="overlay-body">
          {phase === "recording" && (
            <span className="vu" aria-hidden="true">
              <span
                className="vu-bar"
                style={{ width: `${Math.min(100, Math.round(audioLevel * 260))}%` }}
              />
            </span>
          )}
          <span
            ref={isRecordingLike && transcript ? realtimeTextRef : undefined}
            className={`overlay-text${phase === "error" ? " overlay-text-error" : ""}${isRecordingLike && transcript ? " overlay-text-realtime" : ""}`}
          >
            {text}
          </span>
        </div>
        {phase === "error" && (
          <span className="overlay-meta">
            詳細はログファイルに出力されています
          </span>
        )}
        {phase === "recording" && captureMode === "toggle" && (
          <span className="overlay-meta">
            ショートカットをもう一度押すと停止します
          </span>
        )}
      </div>
    </div>
  );
}
