import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TranscriptionSession } from "./transcription";
import { postprocess } from "./postprocess";
import { loadSettings } from "./useSettings";
import { getApiKey } from "./apiKeyStore";
import { OverlayStatus } from "./types";

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
  const [status, setStatus] = useState<OverlayStatus>("listening");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [fading, setFading] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const realtimeTextRef = useRef<HTMLSpanElement>(null);
  const isStartingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cachedApiKeyRef = useRef("");
  const cachedSettingsRef = useRef(loadSettings());

  useEffect(() => {
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

  useEffect(() => {
    const tick = () => {
      const s = sessionRef.current;
      if (status === "listening" && s) {
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
  }, [status]);

  // リアルタイムテキスト末尾を常に表示
  useEffect(() => {
    if (realtimeTextRef.current) {
      realtimeTextRef.current.scrollTop = realtimeTextRef.current.scrollHeight;
    }
  }, [transcript]);

  // エラー詳細はログファイルに出力されるため、クリップボードコピーは不要

  const handleStart = async () => {
    // 処理中（transcribing/formatting）なら abort してキャンセル
    if (abortRef.current) {
      abortRef.current.abort();
      return;
    }
    // 多重起動ガード（最初の await より前に同期的にセット）
    if (isStartingRef.current || sessionRef.current) return;
    isStartingRef.current = true;

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
    const apiKey = await getApiKey();
    cachedSettingsRef.current = settings;
    cachedApiKeyRef.current = apiKey;
    setStatus("listening");
    setTranscript("");
    setErrorMsg("");
    setFading(false);
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
        onInterimResult: (text) => setTranscript(text),
      });
    } catch (e) {
      isStartingRef.current = false;
      console.error("[FreeVoice] handleStart failed", e);
      setStatus("error");
      setErrorMsg(toUserMessage(e));
      scheduleHide(5000);
      await trySaveLog(settings.logFolder.trim(), now, { transcription: "", formatted: "", error: formatError(e) });
    }
  };

  const handleStop = async () => {
    // await より前にフラグとセッションを退避・クリア（多重起動対策）
    isStartingRef.current = false;
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;

    const settings = cachedSettingsRef.current;
    const apiKey = cachedApiKeyRef.current;

    const now = new Date();
    let rawTranscript = "";
    let formattedText = "";
    let stopError: unknown = null;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("transcribing");

    try {
      const raw = await session.stop(controller.signal);
      if (!raw.trim()) {
        abortRef.current = null;
        if (session.wasSilent) {
          setStatus("listening");
          setTranscript("音声が検出されませんでした");
          scheduleHide(1500);
        } else {
          scheduleHide(150);
        }
        return;
      }

      rawTranscript = raw;
      setTranscript(raw);
      setStatus("formatting");
      const formatted = await postprocess(
        raw,
        settings.endpoint,
        apiKey,
        settings.postprocessModel,
        settings.postprocessPrompt,
        settings.reasoningEffort,
        controller.signal
      );
      formattedText = formatted;

      await invoke("paste_text", { text: formatted, method: settings.inputMethod });
      setStatus("done");
      scheduleHide(1000);
    } catch (e) {
      // AbortError はキャンセルなので即非表示（フェード不要）
      if (e instanceof DOMException && e.name === "AbortError") {
        const appWindow = getCurrentWebviewWindow();
        await appWindow.hide();
        setStatus("listening");
        setTranscript("");
        return;
      }
      stopError = e;
      console.error("[FreeVoice] handleStop failed", e);
      setStatus("error");
      setErrorMsg(toUserMessage(e));
      scheduleHide(5000);
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

  const scheduleHide = (ms: number) => {
    setTimeout(async () => {
      setFading(true);
      setTimeout(async () => {
        const appWindow = getCurrentWebviewWindow();
        await appWindow.hide();
        setFading(false);
        setStatus("listening");
        setTranscript("");
      }, 400);
    }, ms);
  };

  const pillClass = [
    "overlay-pill",
    `status-${status}`,
    fading ? "fading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const icon =
    status === "listening" ? "●" :
    (status === "transcribing" || status === "formatting") ? <span className="spinner">◌</span> :
    status === "done" ? "✓" :
    "!";

  const statusLabel =
    status === "listening"
      ? "Recording"
      : status === "transcribing"
      ? "Transcribing"
      : status === "formatting"
      ? "Formatting"
      : status === "done"
      ? "Done"
      : "Error";

  const text =
    status === "listening"
      ? transcript || (silentWarn ? "Microphone input may be silent" : "Listening...")
      : status === "transcribing"
      ? "Transcribing..."
      : status === "formatting"
      ? "Formatting..."
      : status === "done"
      ? "Completed"
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
          {status === "listening" && (
            <span className="vu" aria-hidden="true">
              <span
                className="vu-bar"
                style={{ width: `${Math.min(100, Math.round(audioLevel * 260))}%` }}
              />
            </span>
          )}
          <span
            ref={status === "listening" && transcript ? realtimeTextRef : undefined}
            className={`overlay-text${status === "error" ? " overlay-text-error" : ""}${status === "listening" && transcript ? " overlay-text-realtime" : ""}`}
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
