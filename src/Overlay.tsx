import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TranscriptionSession } from "./transcription";
import { postprocess } from "./postprocess";
import { loadSettings } from "./useSettings";
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

export default function Overlay() {
  const [status, setStatus] = useState<OverlayStatus>("listening");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorCopied, setErrorCopied] = useState(false);
  const [fading, setFading] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);

  useEffect(() => {
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

  useEffect(() => {
    if (status !== "error" || !errorMsg) return;
    let active = true;
    (async () => {
      try {
        await navigator.clipboard.writeText(errorMsg);
        if (active) setErrorCopied(true);
      } catch (e) {
        console.error("[FreeVoice] clipboard copy failed", e);
        if (active) setErrorCopied(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [status, errorMsg]);

  const handleStart = async () => {
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
    setStatus("listening");
    setTranscript("");
    setErrorMsg("");
    setErrorCopied(false);
    setFading(false);
    setAudioLevel(0);
    setSilentWarn(false);
    silentSinceRef.current = null;

    const appWindow = getCurrentWebviewWindow();
    await appWindow.setFocusable(false).catch(() => {});
    await invoke("position_overlay").catch(() => {});
    await appWindow.show();

    const session = new TranscriptionSession();
    sessionRef.current = session;

    try {
      await session.start(settings.endpoint, settings.apiKey, settings.transcriptionModel);
    } catch (e) {
      console.error("[FreeVoice] handleStart failed", e);
      setStatus("error");
      setErrorMsg(formatError(e));
      scheduleHide(5000);
    }
  };

  const handleStop = async () => {
    const settings = loadSettings();
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;

    try {
      const raw = await session.stop();
      if (!raw.trim()) {
        scheduleHide(150);
        return;
      }

      setTranscript(raw);
      setStatus("formatting");
      const formatted = await postprocess(
        raw,
        settings.endpoint,
        settings.apiKey,
        settings.postprocessModel,
        settings.postprocessPrompt
      );

      await invoke("paste_text", { text: formatted });
      setStatus("done");
      scheduleHide(1000);
    } catch (e) {
      console.error("[FreeVoice] handleStop failed", e);
      setStatus("error");
      setErrorMsg(formatError(e));
      scheduleHide(5000);
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
    status === "formatting" ? <span className="spinner">◌</span> :
    status === "done" ? "✓" :
    "!";

  const statusLabel =
    status === "listening"
      ? "Recording"
      : status === "formatting"
      ? "Formatting"
      : status === "done"
      ? "Done"
      : "Error";

  const text =
    status === "listening"
      ? transcript || (silentWarn ? "Microphone input may be silent" : "Listening...")
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
          <span className={`overlay-text ${status === "error" ? "overlay-text-error" : ""}`}>
            {text}
          </span>
        </div>
        {status === "error" && (
          <span className="overlay-meta">
            {errorCopied
              ? "Error details copied to clipboard"
              : "Failed to copy error details to clipboard"}
          </span>
        )}
      </div>
    </div>
  );
}
