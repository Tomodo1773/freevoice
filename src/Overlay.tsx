import { useState, useReducer, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TranscriptionSession } from "./transcription";
import { postprocessWithRetry } from "./postprocess";
import { loadSettings } from "./useSettings";
import { getAllApiKeys, migrateFormatApiKey } from "./apiKeyStore";
import { overlayReducer, initialState } from "./overlayReducer";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 詳細なエラーを短い定型メッセージに変換する（オーバーレイ表示用） */
function toUserMessage(err: unknown): string {
  const msg = formatError(err);
  if (msg.startsWith("文字起こしAPI エラー")) return "文字起こしAPIでエラーが発生しました";
  if (msg.startsWith("後処理API エラー")) return "後処理APIでエラーが発生しました";
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

async function saveLogEntry(
  logFolder: string,
  now: Date,
  data: { transcription: string; formatted: string; error?: string }
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
  data: { transcription: string; formatted: string; error?: string }
): Promise<void> {
  try {
    const logFolder = configuredFolder || await invoke<string>("get_app_log_dir");
    await saveLogEntry(logFolder, now, data);
  } catch (logErr) {
    console.error("[FreeVoice] save_log failed", logErr);
  }
}

export default function Overlay() {
  const [state, dispatch] = useReducer(overlayReducer, initialState);
  const { phase, transcript, errorMsg, fallback, fallbackReason, fading, hideRequest } = state;

  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const realtimeTextRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cachedApiKeyRef = useRef("");
  const cachedFormatApiKeyRef = useRef("");
  const cachedSettingsRef = useRef(loadSettings());

  useEffect(() => {
    migrateFormatApiKey().catch(() => {});
    // 古いログフォルダを起動時にクリーンアップ
    (async () => {
      try {
        const settings = loadSettings();
        const logFolder = settings.logFolder.trim() || await invoke<string>("get_app_log_dir");
        await invoke("cleanup_old_logs", { folder: logFolder, keepDays: 30 });
      } catch (e) {
        console.error("[FreeVoice] cleanup_old_logs failed", e);
      }
    })();

    const appWindow = getCurrentWebviewWindow();
    appWindow.setFocusable(false).catch(() => {});
    invoke("set_click_through").catch(() => {});
    invoke("position_overlay").catch(() => {});

    // In React StrictMode (dev), effects can mount/unmount twice.
    // Ensure we don't leak duplicate global event listeners.
    let disposed = false;
    let unlistenStart: (() => void) | undefined;
    let unlistenStop: (() => void) | undefined;

    (async () => {
      const u1 = await listen("recording-start", () => {
        handleStart();
      });
      const u2 = await listen("recording-stop", () => {
        handleStop();
      });

      if (disposed) {
        u1();
        u2();
        return;
      }

      unlistenStart = u1;
      unlistenStop = u2;
    })();

    return () => {
      disposed = true;
      unlistenStart?.();
      unlistenStop?.();
    };
  }, []);

  // VUメーター更新ループ
  useEffect(() => {
    const tick = () => {
      const s = sessionRef.current;
      if (phase === "recording" && s) {
        const lvl = s.getAudioLevel();
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

  // エラー詳細はログファイルに出力されるため、クリップボードコピーは不要

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

    const timer = setTimeout(async () => {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.hide();
      dispatch({ type: "FADE_DONE" });
    }, 400);

    return () => clearTimeout(timer);
  }, [fading]);

  const handleStart = async () => {
    // 処理中（transcribing/formatting）なら abort してキャンセル
    if (abortRef.current) {
      abortRef.current.abort();
      return;
    }
    // 多重起動ガード（最初の await より前に同期的にチェック）
    if (sessionRef.current) return;

    dispatch({ type: "RECORDING_START" });

    const now = new Date();
    // 録音開始音
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

    const settings = loadSettings();
    const { apiKey, azureFormatApiKey, openaiFormatApiKey } = await getAllApiKeys();
    cachedSettingsRef.current = settings;
    cachedApiKeyRef.current = apiKey;
    cachedFormatApiKeyRef.current = settings.formatProvider === "openai" ? openaiFormatApiKey : azureFormatApiKey;
    setAudioLevel(0);
    setSilentWarn(false);
    silentSinceRef.current = null;

    const appWindow = getCurrentWebviewWindow();

    // オーバーレイ表示と getUserMedia を並列実行（100-300ms短縮）
    const [, mediaStream] = await Promise.all([
      (async () => {
        await Promise.all([
          appWindow.setFocusable(false).catch(() => {}),
          invoke("position_overlay").catch(() => {}),
        ]);
        await appWindow.show();
      })(),
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true,
          ...(settings.audioDeviceId ? { deviceId: { exact: settings.audioDeviceId } } : {}),
        },
      }),
    ]);

    const session = new TranscriptionSession();
    sessionRef.current = session;

    invoke("set_system_audio_mute", { mute: true }).catch((e: unknown) => console.warn("mute failed", e));

    try {
      await session.start({
        provider: settings.transcriptionProvider,
        endpoint: settings.endpoint,
        apiKey,
        model: settings.transcriptionModel,
        speechEndpoint: settings.speechEndpoint,
        speechLanguage: settings.speechLanguage,
        audioDeviceId: settings.audioDeviceId,
        mediaStream,
        onInterimResult: (text) => dispatch({ type: "SET_TRANSCRIPT", transcript: text }),
      });
    } catch (e) {
      sessionRef.current = null;
      invoke("set_system_audio_mute", { mute: false }).catch((e: unknown) => console.warn("unmute failed", e));
      console.error("[FreeVoice] handleStart failed", e);
      dispatch({ type: "RECORDING_FAILED", errorMsg: toUserMessage(e) });
      await trySaveLog(settings.logFolder.trim(), now, { transcription: "", formatted: "", error: formatError(e) });
    }
  };

  const handleStop = async () => {
    // await より前にセッションを退避・クリア（多重起動対策）
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;

    invoke("set_system_audio_mute", { mute: false }).catch((e: unknown) => console.warn("unmute failed", e));

    const settings = cachedSettingsRef.current;

    const now = new Date();
    let rawTranscript = "";
    let formattedText = "";
    let stopError: unknown = null;

    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "STOP_TRANSCRIBING" });

    try {
      const raw = await session.stop(controller.signal);
      if (!raw.trim()) {
        abortRef.current = null;
        dispatch({ type: "TRANSCRIPT_EMPTY", silent: session.wasSilent });
        return;
      }

      rawTranscript = raw;
      dispatch({ type: "TRANSCRIPT_READY", transcript: raw });
      const formatModel = settings.formatProvider === "openai" ? settings.openaiFormatModel : settings.azureFormatModel;
      const { text: formatted, fallback, fallbackReason } = await postprocessWithRetry(
        raw,
        settings.formatProvider,
        settings.formatEndpoint,
        cachedFormatApiKeyRef.current,
        formatModel,
        settings.postprocessPrompt,
        settings.reasoningEffort,
        controller.signal
      );
      formattedText = formatted;

      await invoke("paste_text", { text: formatted, method: settings.inputMethod });
      dispatch({ type: "FORMAT_DONE", fallback, fallbackReason });
    } catch (e) {
      // AbortError はキャンセルなので即非表示（フェード不要）
      if (e instanceof DOMException && e.name === "AbortError") {
        const appWindow = getCurrentWebviewWindow();
        await appWindow.hide();
        dispatch({ type: "ABORT_CANCELLED" });
        return;
      }
      stopError = e;
      console.error("[FreeVoice] handleStop failed", e);
      dispatch({ type: "STOP_ERROR", errorMsg: toUserMessage(e) });
    } finally {
      abortRef.current = null;
      const configuredFolder = settings.logFolder.trim();
      const hasError = stopError !== null && formattedText === "";
      // 設定フォルダがある → 全ログ出力。設定なし + エラー → デフォルトパスにエラーログのみ出力
      if (rawTranscript || hasError) {
        await trySaveLog(configuredFolder, now, {
          transcription: rawTranscript,
          formatted: formattedText,
          ...(hasError ? { error: formatError(stopError) } : {}),
        });
      }
    }
  };

  // phase から既存 CSS クラス名へのマッピング（CSS変更不要にする）
  const cssStatus =
    (phase === "recording" || phase === "idle") ? "listening" : phase;

  const pillClass = [
    "overlay-pill",
    `status-${cssStatus}`,
    fading ? "fading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const icon =
    phase === "recording" ? "●" :
    (phase === "transcribing" || phase === "formatting") ? <span className="spinner">◌</span> :
    phase === "done" ? "✓" :
    phase === "error" ? "!" :
    null;

  const statusLabel =
    phase === "recording"
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
    phase === "recording"
      ? transcript || (silentWarn ? "Microphone input may be silent" : "Listening...")
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
            ref={phase === "recording" && transcript ? realtimeTextRef : undefined}
            className={`overlay-text${phase === "error" ? " overlay-text-error" : ""}${phase === "recording" && transcript ? " overlay-text-realtime" : ""}`}
          >
            {text}
          </span>
        </div>
        {phase === "error" && (
          <span className="overlay-meta">
            詳細はログファイルに出力されています
          </span>
        )}
      </div>
    </div>
  );
}

