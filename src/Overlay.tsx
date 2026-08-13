import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TranscriptionSession } from "./transcription";
import { postprocessWithRetry, warmupFormatConnection } from "./postprocess";
import { getContext, refreshContext } from "./windowContext";
import { sendLlmSpan } from "./langsmithTrace";
import { loadSettings, persistSettings } from "./useSettings";
import { getAllApiKeys, migrateFormatApiKey } from "./apiKeyStore";
import { OverlayView } from "./overlayView";
import {
  RecorderController,
  type RecorderDeps,
  type RecordingConfig,
  type RecordingWindow,
  type SessionCallbacks,
  type PendingSession,
  type FormatOutcome,
  type LogData,
} from "./recorder";
import { logInfo, logWarn, logError, setLogPhaseSource } from "./diagLog";
import type { AppSettings } from "./types";

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

// 失効したデバイスIDで getUserMedia すると WebView2 で hang するため、事前検証して自己治癒する
async function validateAudioDevice(
  settings: AppSettings
): Promise<{ effectiveDeviceId: string; settings: AppSettings }> {
  const { audioDeviceId } = settings;
  if (!audioDeviceId) return { effectiveDeviceId: "", settings };

  const devices = await navigator.mediaDevices.enumerateDevices();
  const exists = devices.some((d) => d.kind === "audioinput" && d.deviceId === audioDeviceId);
  if (exists) return { effectiveDeviceId: audioDeviceId, settings };

  logWarn("overlay.validateAudioDevice", "saved audioDeviceId not found, falling back to default", {
    audioDeviceId,
  });
  const updated = { ...settings, audioDeviceId: "" };
  persistSettings(updated);
  return { effectiveDeviceId: "", settings: updated };
}

async function loadConfig(): Promise<RecordingConfig> {
  const initial = loadSettings();
  const { apiKey, azureFormatApiKey, openaiFormatApiKey, langsmithApiKey } = await getAllApiKeys();
  const formatApiKey = initial.formatProvider === "openai" ? openaiFormatApiKey : azureFormatApiKey;
  warmupFormatConnection(initial.formatProvider, initial.formatEndpoint);
  const { effectiveDeviceId, settings } = await validateAudioDevice(initial);
  return { settings, apiKey, formatApiKey, langsmithApiKey, effectiveDeviceId };
}

async function resolveWindow(): Promise<RecordingWindow | null> {
  const fw = await invoke<{ id: string; exe: string; title: string }>("get_foreground_window");
  return fw.id ? { id: fw.id, exe: fw.exe, title: fw.title } : null;
}

async function acquireMic(config: RecordingConfig): Promise<MediaStream> {
  const id = config.effectiveDeviceId;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      ...(id ? { deviceId: { exact: id } } : {}),
    },
  });
}

function createTranscriptionSession(
  mic: MediaStream,
  config: RecordingConfig,
  callbacks: SessionCallbacks
): PendingSession {
  const s = config.settings;
  const session = new TranscriptionSession();
  const ready = session.start({
    provider: s.transcriptionProvider,
    endpoint: s.endpoint,
    apiKey: config.apiKey,
    model: s.transcriptionModel,
    speechEndpoint: s.speechEndpoint,
    speechLanguage: s.speechLanguage,
    mediaStream: mic,
    onInterimResult: callbacks.onInterim,
    onRecognitionError: callbacks.onError,
  });
  return { session, ready };
}

function formatModelOf(s: AppSettings): string {
  return s.formatProvider === "openai" ? s.openaiFormatModel : s.azureFormatModel;
}

async function formatText(
  raw: string,
  config: RecordingConfig,
  context: string | null,
  signal: AbortSignal
): Promise<FormatOutcome> {
  const s = config.settings;
  const formatModel = formatModelOf(s);
  const formatStartMs = Date.now();
  const {
    text,
    fallback,
    fallbackReason,
    usage,
    model: responseModel,
    errorStatus,
    messages,
  } = await postprocessWithRetry(
    raw,
    s.formatProvider,
    s.formatEndpoint,
    config.formatApiKey,
    formatModel,
    s.postprocessPrompt,
    s.reasoningEffort,
    context ?? undefined,
    signal
  );
  const formatEndMs = Date.now();

  if (s.langsmithEnabled) {
    void sendLlmSpan({
      spanName: "format",
      region: s.langsmithRegion,
      project: s.langsmithProject,
      apiKey: config.langsmithApiKey,
      includeContent: s.langsmithIncludeContent,
      provider: s.formatProvider,
      requestModel: formatModel,
      responseModel,
      messages,
      completion: fallback ? undefined : text,
      reasoningEffort: s.reasoningEffort,
      usage,
      startTimeMs: formatStartMs,
      endTimeMs: formatEndMs,
      error: fallback ? { message: fallbackReason ?? "format fallback", status: errorStatus } : undefined,
    });
  }

  return { text, fallback, fallbackReason: fallbackReason ?? "" };
}

function refreshTopic(win: RecordingWindow, formatted: string, config: RecordingConfig): void {
  const s = config.settings;
  const langsmithConfig = s.langsmithEnabled
    ? {
        region: s.langsmithRegion,
        project: s.langsmithProject,
        apiKey: config.langsmithApiKey,
        includeContent: s.langsmithIncludeContent,
      }
    : undefined;
  void refreshContext(
    win.id,
    win.exe,
    win.title,
    formatted,
    {
      formatProvider: s.formatProvider,
      endpoint: s.formatEndpoint,
      apiKey: config.formatApiKey,
      model: formatModelOf(s),
      reasoningEffort: s.reasoningEffort,
    },
    langsmithConfig
  );
}

async function saveLogEntry(logFolder: string, now: Date, data: LogData): Promise<void> {
  const isoTimestamp = now.toISOString();
  const datePart = isoTimestamp.slice(0, 10); // YYYY-MM-DD
  const timePart = isoTimestamp.slice(11).replace(/:/g, "-").replace(/\./g, "-"); // HH-MM-SS-mmmZ
  const folder = `${logFolder}/${datePart}`;
  const filename = `freevoice-${timePart}.json`;
  const content = JSON.stringify({ timestamp: isoTimestamp, ...data }, null, 2);
  await invoke("save_log", { folder, filename, content });
}

async function saveLog(config: RecordingConfig, now: Date, data: LogData): Promise<void> {
  try {
    const logFolder = config.settings.logFolder.trim() || (await invoke<string>("get_app_log_dir"));
    await saveLogEntry(logFolder, now, data);
  } catch (logErr) {
    logError("overlay.saveLog", "save_log failed", logErr);
  }
}

function setSystemMute(mute: boolean): Promise<void> {
  // COM 経由のミュートは録音開始のクリティカルパスを塞がないよう投げっぱなしにする。
  invoke("set_system_audio_mute", { mute }).catch((e: unknown) =>
    logWarn("overlay.setSystemMute", "set_system_audio_mute failed", { error: e, mute })
  );
  return Promise.resolve();
}

function setCancelable(cancelable: boolean): void {
  invoke("set_cancelable", { cancelable }).catch((e: unknown) =>
    logWarn("overlay.setCancelable", "set_cancelable failed", { error: e, cancelable })
  );
}

/** マイク初期化・セッション確立に許す最大時間。超過を「停滞」とみなしエラーで復帰させる。 */
const START_TIMEOUT_MS = 4000;

function buildDeps(view: OverlayView): RecorderDeps {
  return {
    view,
    now: () => new Date(),
    startTimeoutMs: START_TIMEOUT_MS,
    beep: playStartBeep,
    loadConfig,
    resolveWindow: () => resolveWindow(),
    acquireMic,
    createSession: createTranscriptionSession,
    setMute: setSystemMute,
    setCancelable,
    getContext,
    format: formatText,
    paste: (text, config) => invoke("paste_text", { text, method: config.settings.inputMethod }),
    saveLog,
    refreshTopic,
  };
}

export default function Overlay() {
  // 表示専用ストア（OverlayView）と録音制御（RecorderController）を1度だけ組み立てる。
  // 制御はジョブ単一所有、表示はトースト/フェード所有、と責務を分離する。
  const viewRef = useRef<OverlayView | null>(null);
  const controllerRef = useRef<RecorderController | null>(null);
  if (viewRef.current === null) {
    const view = new OverlayView({
      showWindow: () => {
        void (async () => {
          await invoke("position_overlay").catch((e) =>
            logWarn("overlay.showWindow", "position_overlay failed", { error: e })
          );
          await getCurrentWebviewWindow()
            .show()
            .catch((e) => logWarn("overlay.showWindow", "show failed", { error: e }));
        })();
      },
      hideWindow: () => {
        void getCurrentWebviewWindow()
          .hide()
          .catch((e) => logWarn("overlay.hideWindow", "hide failed", { error: e }));
      },
    });
    viewRef.current = view;
    controllerRef.current = new RecorderController(buildDeps(view));
    setLogPhaseSource(() => view.getState().status);
  }
  const view = viewRef.current;
  const controller = controllerRef.current!;
  const state = useSyncExternalStore(view.subscribe, view.getState);
  const { status, transcript, errorMsg, fallback, fallbackReason, fading } = state;

  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);

  const realtimeTextRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);

  useEffect(() => {
    logInfo("overlay.init", "overlay window initialized");
    migrateFormatApiKey().catch((e) =>
      logWarn("overlay.init", "migrateFormatApiKey failed", { error: e })
    );
    // 古いログフォルダを起動時にクリーンアップ
    (async () => {
      try {
        const settings = loadSettings();
        const logFolder = settings.logFolder.trim() || (await invoke<string>("get_app_log_dir"));
        await invoke("cleanup_old_logs", { folder: logFolder, keepDays: 30 });
      } catch (e) {
        logError("overlay.init", "cleanup_old_logs failed", e);
      }
    })();

    invoke("set_click_through").catch((e) =>
      logWarn("overlay.init", "set_click_through failed", { error: e })
    );
    invoke("position_overlay").catch((e) =>
      logWarn("overlay.init", "position_overlay failed", { error: e })
    );

    // In React StrictMode (dev), effects can mount/unmount twice.
    // Ensure we don't leak duplicate global event listeners.
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const unlisteners = await Promise.all([
        listen("recording-start", () => controller.keyDown()),
        listen("recording-stop", () => controller.keyUp()),
        // 処理中の Esc（低レベルフックが消費したもの）だけが届く
        listen("recording-cancel", () => controller.cancel()),
        // トレイ「履歴ログを開く」から発火。設定済みフォルダ（空ならデフォルト）を Rust で開く
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
  }, [controller]);

  // VUメーター更新ループ。録音中のみ、現在ジョブの音声レベルを読む。
  const isRecordingActive = status === "recording";
  useEffect(() => {
    const tick = () => {
      // 表示上の recording は開始待ちも含む。無音時間はセッション確立後だけ計測する。
      if (view.getState().status === "recording" && controller.isRecording) {
        const lvl = controller.getAudioLevel();
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
        silentSinceRef.current = null;
        setAudioLevel(0);
        setSilentWarn(false);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isRecordingActive, controller, view]);

  // リアルタイムテキスト末尾を常に表示
  useEffect(() => {
    if (realtimeTextRef.current) {
      realtimeTextRef.current.scrollTop = realtimeTextRef.current.scrollHeight;
    }
  }, [transcript]);

  // empty（無音終端）は表示上は recording と同じ「listening」系で扱い、現行の見た目を温存する。
  const isRecordingLike = status === "starting" || status === "recording" || status === "empty";

  // status から既存 CSS クラス名へのマッピング（CSS変更不要にする）
  const cssStatus = isRecordingLike || status === "hidden" ? "listening" : status;

  const pillClass = ["overlay-pill", `status-${cssStatus}`, fading ? "fading" : ""]
    .filter(Boolean)
    .join(" ");

  const icon =
    status === "starting" ? <span className="spinner">◌</span> :
    isRecordingLike ? "●" :
    (status === "transcribing" || status === "formatting") ? <span className="spinner">◌</span> :
    status === "done" ? "✓" :
    status === "error" ? "!" :
    null;

  const statusLabel =
    status === "starting"
      ? "Preparing"
      : isRecordingLike
      ? "Recording"
      : status === "transcribing"
      ? "Transcribing"
      : status === "formatting"
      ? "Formatting"
      : status === "done"
      ? "Done"
      : status === "error"
      ? "Error"
      : "";

  const text =
    status === "starting"
      ? "Preparing..."
      : isRecordingLike
      ? transcript || (silentWarn ? "Microphone input may be silent" : "Listening...")
      : status === "transcribing"
      ? "Transcribing..."
      : status === "formatting"
      ? "Formatting..."
      : status === "done"
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
          {status === "recording" && (
            <span className="vu" aria-hidden="true">
              <span
                className="vu-bar"
                style={{ width: `${Math.min(100, Math.round(audioLevel * 260))}%` }}
              />
            </span>
          )}
          <span
            ref={isRecordingLike && transcript ? realtimeTextRef : undefined}
            className={`overlay-text${status === "error" ? " overlay-text-error" : ""}${isRecordingLike && transcript ? " overlay-text-realtime" : ""}`}
          >
            {text}
          </span>
        </div>
        {status === "error" && (
          <span className="overlay-meta">
            詳細はログファイルに出力されています
          </span>
        )}
      </div>
    </div>
  );
}
