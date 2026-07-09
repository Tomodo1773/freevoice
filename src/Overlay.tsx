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
import { createOverlayStore, decideStartEdge, decideStopEdge } from "./overlayReducer";
import { formatError } from "./errors";
import { logInfo, logWarn, logError } from "./diagLog";

/** 開始処理がこの時間内に session を確立できなければ「停滞」とみなし、再押下での再試行を許す。
 *  通常のマイク初期化（100-300ms）や短い権限応答では発火せず、真に hang した場合のみ復帰させる。 */
const START_STALL_MS = 4000;

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
  // 制御 status の単一ストア。UI は購読して描画し、イベントハンドラは store.getState() で
  // 最新 status を同期読み取りする（sessionRef/abortRef は状態判定に使わず実行リソースに降格）。
  const storeRef = useRef<ReturnType<typeof createOverlayStore> | null>(null);
  if (storeRef.current === null) storeRef.current = createOverlayStore();
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const dispatch = store.dispatch;
  const { phase, transcript, errorMsg, fallback, fallbackReason, fading, hideRequest } = state;

  const [audioLevel, setAudioLevel] = useState(0);
  const [silentWarn, setSilentWarn] = useState(false);

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const realtimeTextRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 開始試行の世代とその開始時刻。getUserMedia 等が停滞して phase=recording のまま
  // session が確立しない場合に、再押下での再試行を安全に許すためのガード。
  const startEpochRef = useRef(0);
  const startAttemptAtRef = useRef(0);
  const recordingWindowPromiseRef = useRef<Promise<{ id: string; exe: string; title: string } | null> | null>(null);
  const cachedApiKeyRef = useRef("");
  const cachedFormatApiKeyRef = useRef("");
  const cachedLangsmithApiKeyRef = useRef("");
  const cachedSettingsRef = useRef(loadSettings());

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
    invoke("position_overlay").catch((e) =>
      logWarn("overlay.init", "position_overlay failed", { error: e })
    );

    // In React StrictMode (dev), effects can mount/unmount twice.
    // Ensure we don't leak duplicate global event listeners.
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const unlisteners = await Promise.all([
        listen("recording-start", () => handleStart()),
        listen("recording-stop", () => handleStop()),
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

  // 処理（transcribing/formatting）への遷移と、キャンセル用 AbortController を対で扱う。
  // set と dispatch を1関数に閉じ込め、「abortRef 非null ⟺ 処理中 status」の整合を
  // 実行順序ではなく構造で担保する（並べ替えで静かにキャンセルが壊れるのを防ぐ）。
  const beginProcessing = (): AbortController => {
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "STOP_TRANSCRIBING" });
    return controller;
  };
  const endProcessing = () => {
    abortRef.current = null;
  };

  const handleStart = async () => {
    // キーエッジの意味は現在の status だけから決める（判定を1箇所に集約）。
    // 最初の await より前に同期的に評価する。
    const edge = decideStartEdge(store.getState().phase);
    if (edge === "cancel") {
      // 処理中（transcribing/formatting）の再押下＝キャンセル。abortRef は status に従属する実行リソース。
      logInfo("overlay.handleStart", "cancel requested: aborting in-flight processing");
      abortRef.current?.abort();
      return;
    }
    if (edge === "ignore") {
      // phase=recording。session が確立済みなら本当に録音中なので無視。
      // 一方 session 未確立のまま START_STALL_MS 超なら開始処理が停滞している。
      // その場合だけ再押下での再試行を許す（下の epoch で停滞中の試行を無効化する）。
      const stalled = !sessionRef.current
        && Date.now() - startAttemptAtRef.current >= START_STALL_MS;
      if (!stalled) {
        // 録音中に再度キーが来た＝取りこぼしや二重押下。無言で捨てず記録する。
        logWarn("overlay.handleStart", "start ignored: recording already active");
        return;
      }
      logWarn("overlay.handleStart", "restarting stalled start attempt");
    }

    // onRecognitionError は error へ遷移させるがセッションは解放しない（phase 判定では拾えない）。
    // 新規録音を始める前に、居残った旧セッションを確実に解放してリソースリークを防ぐ。
    const staleSession = sessionRef.current;
    if (staleSession) {
      sessionRef.current = null;
      void staleSession.stop().catch((e: unknown) =>
        logWarn("overlay.handleStart", "stale session cleanup failed", { error: e })
      );
    }

    // この開始試行の世代印。以降の await で世代が進んでいたら（新たな start に追い越されたら）
    // 途中で確保したリソースを解放して黙って降りる。
    const epoch = ++startEpochRef.current;
    startAttemptAtRef.current = Date.now();

    logInfo("overlay.handleStart", "start");
    dispatch({ type: "RECORDING_START" });
    recordingWindowPromiseRef.current = null;

    const now = new Date();
    // 録音開始音。失敗しても録音本体は続行するため、握り潰さず記録だけする。
    try {
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
    } catch (e) {
      logWarn("overlay.handleStart", "start beep failed", { error: e });
    }

    let mediaStream: MediaStream | null = null;
    let settings = cachedSettingsRef.current;
    try {
      settings = loadSettings();
      const { apiKey, azureFormatApiKey, openaiFormatApiKey, langsmithApiKey } = await getAllApiKeys();
      cachedSettingsRef.current = settings;
      cachedApiKeyRef.current = apiKey;
      cachedFormatApiKeyRef.current = settings.formatProvider === "openai" ? openaiFormatApiKey : azureFormatApiKey;
      cachedLangsmithApiKeyRef.current = langsmithApiKey;
      // 整形APIへの接続を録音中に温めておく（TLSハンドシェイクをクリティカルパスから外す）
      warmupFormatConnection(settings.formatProvider, settings.formatEndpoint);

      // 文脈スコープ用にフォアグラウンドウィンドウを取得。await せず録音中に解決させ、
      // overlay show + getUserMedia の並列化（クリティカルパス）を阻害しない。
      if (settings.contextAwareFormatting) {
        recordingWindowPromiseRef.current = invoke<{ id: string; exe: string; title: string }>("get_foreground_window")
          .then((fw) => (fw.id ? { id: fw.id, exe: fw.exe, title: fw.title } : null))
          .catch((e) => {
            logWarn("overlay.handleStart", "get_foreground_window failed", { error: e });
            return null;
          });
      }

      setAudioLevel(0);
      setSilentWarn(false);
      silentSinceRef.current = null;

      // 保存済み audioDeviceId が現在のデバイス一覧に存在するか検証。
      // 失効していると getUserMedia が WebView2 で hang するため、空に戻して localStorage を自己治癒する。
      let effectiveDeviceId = settings.audioDeviceId;
      if (effectiveDeviceId) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const exists = devices.some((d) => d.kind === "audioinput" && d.deviceId === effectiveDeviceId);
        if (!exists) {
          logWarn("overlay.handleStart", "saved audioDeviceId not found, falling back to default", {
            audioDeviceId: effectiveDeviceId,
          });
          effectiveDeviceId = "";
          settings = { ...settings, audioDeviceId: "" };
          persistSettings(settings);
          cachedSettingsRef.current = settings;
        }
      }

      const appWindow = getCurrentWebviewWindow();

      // オーバーレイ表示と getUserMedia を並列実行（100-300ms短縮）
      const [, ms] = await Promise.all([
        (async () => {
          await invoke("position_overlay").catch((e) =>
            logWarn("overlay.handleStart", "position_overlay failed", { error: e })
          );
          await appWindow.show();
        })(),
        navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            noiseSuppression: true,
            echoCancellation: true,
            ...(effectiveDeviceId ? { deviceId: { exact: effectiveDeviceId } } : {}),
          },
        }),
      ]);
      mediaStream = ms;

      // 別の start に追い越されていたら、掴んだマイクを解放してこの試行は降りる
      // （まだ session もミュートも触っていないのでストリーム停止だけでよい）。
      if (startEpochRef.current !== epoch) {
        logWarn("overlay.handleStart", "start superseded before session setup");
        mediaStream.getTracks().forEach((t) => t.stop());
        return;
      }

      const session = new TranscriptionSession();
      sessionRef.current = session;

      invoke("set_system_audio_mute", { mute: true }).catch((e: unknown) =>
        logWarn("overlay.handleStart", "set_system_audio_mute(true) failed", { error: e })
      );

      await session.start({
        provider: settings.transcriptionProvider,
        endpoint: settings.endpoint,
        apiKey,
        model: settings.transcriptionModel,
        speechEndpoint: settings.speechEndpoint,
        speechLanguage: settings.speechLanguage,
        audioDeviceId: effectiveDeviceId,
        mediaStream,
        onInterimResult: (text) => dispatch({ type: "SET_TRANSCRIPT", transcript: text }),
        // 原因は transcription 側が onRecognitionError 呼び出し前に logError 済みなので、
        // ここでの再ログはノイズになる。UI 更新だけ行う。
        onRecognitionError: (msg) => dispatch({ type: "RECORDING_FAILED", errorMsg: msg }),
      });

      // session.start 中に追い越されていた場合の後始末。追い越した start が
      // staleSession 経由でこの session を既に停止・差し替え済みなら sessionRef は別物なので触らない。
      // ミュート状態は追い越した録音が所有するため解除しない。
      if (startEpochRef.current !== epoch) {
        logWarn("overlay.handleStart", "start superseded after session.start");
        if (sessionRef.current === session) {
          sessionRef.current = null;
          void session.stop().catch((e: unknown) =>
            logWarn("overlay.handleStart", "superseded session cleanup failed", { error: e })
          );
        }
        return;
      }

      logInfo("overlay.handleStart", "recording started", {
        provider: settings.transcriptionProvider,
      });
    } catch (e) {
      // 追い越された試行の失敗は、新しい録音の状態（sessionRef/ミュート/phase）を壊さないよう
      // 自分が掴んだ mediaStream だけ解放して黙って降りる。
      if (startEpochRef.current !== epoch) {
        logWarn("overlay.handleStart", "superseded start attempt failed", { error: e });
        mediaStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      // セッション作成済みならミュート解除。MediaStream が掴まれていれば確実に解放。
      if (sessionRef.current) {
        sessionRef.current = null;
        invoke("set_system_audio_mute", { mute: false }).catch((muteErr: unknown) =>
          logWarn("overlay.handleStart", "set_system_audio_mute(false) failed", { error: muteErr })
        );
      }
      mediaStream?.getTracks().forEach((t) => t.stop());
      logError("overlay.handleStart", "start failed", e, {
        provider: settings.transcriptionProvider,
      });
      dispatch({ type: "RECORDING_FAILED", errorMsg: toUserMessage(e) });
      await trySaveLog(settings.logFolder.trim(), now, { transcription: "", formatted: "", error: formatError(e) });
    }
  };

  const handleStop = async () => {
    // await より前に実行リソース（session）を退避・クリア（多重起動対策）。
    const session = sessionRef.current;
    if (!session) {
      // キーを離したのに何も起きない事象を追えるよう、無視した stop も記録する。
      logInfo("overlay.handleStop", "stop ignored: no active session", {
        phase: store.getState().phase,
        processing: abortRef.current !== null,
      });
      return;
    }
    sessionRef.current = null;

    invoke("set_system_audio_mute", { mute: false }).catch((e: unknown) =>
      logWarn("overlay.handleStop", "set_system_audio_mute(false) failed", { error: e })
    );

    // status が recording でない（例: 認識エラーで既に error へ遷移済み）場合は、
    // 文字起こし/整形パイプラインを回さずリソース解放だけ行う。
    const phaseAtStop = store.getState().phase;
    if (decideStopEdge(phaseAtStop) !== "stop") {
      logInfo("overlay.handleStop", "release without pipeline", { phase: phaseAtStop });
      await session.stop().catch((e: unknown) =>
        logWarn("overlay.handleStop", "cleanup stop failed", { error: e })
      );
      return;
    }

    logInfo("overlay.handleStop", "stop");
    const settings = cachedSettingsRef.current;

    // 録音開始時に起動したウィンドウ取得を解決（録音中に完了済みのはず）し、話題コンテキストを引く
    const winPromise = recordingWindowPromiseRef.current;
    const win = settings.contextAwareFormatting && winPromise ? await winPromise : null;
    const injectedContext = win ? getContext(win.id) : null;

    const now = new Date();
    let rawTranscript = "";
    let formattedText = "";
    let stopError: unknown = null;

    const controller = beginProcessing();

    try {
      const raw = await session.stop(controller.signal);
      if (!raw.trim()) {
        endProcessing();
        const logEmpty = session.wasSilent ? logInfo : logWarn;
        logEmpty("overlay.handleStop", "empty transcript", {
          silent: session.wasSilent,
          provider: settings.transcriptionProvider,
        });
        dispatch({ type: "TRANSCRIPT_EMPTY", silent: session.wasSilent });
        return;
      }

      rawTranscript = raw;
      // 「文字起こしは取れたが以降が進まない」事象の切り分け用に、整形へ渡す直前を記録する。
      logInfo("overlay.handleStop", "transcript received, starting format", {
        provider: settings.transcriptionProvider,
        transcriptLen: raw.length,
        hasContext: !!injectedContext,
      });
      dispatch({ type: "TRANSCRIPT_READY", transcript: raw });
      const formatModel = settings.formatProvider === "openai" ? settings.openaiFormatModel : settings.azureFormatModel;
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
        cachedFormatApiKeyRef.current,
        formatModel,
        settings.postprocessPrompt,
        settings.reasoningEffort,
        injectedContext ?? undefined,
        controller.signal
      );
      const formatEndMs = Date.now();
      formattedText = formatted;
      logInfo("overlay.handleStop", "format complete", {
        fallback,
        fallbackReason,
        formattedLen: formatted.length,
        durationMs: formatEndMs - formatStartMs,
      });

      const langsmithConfig = settings.langsmithEnabled ? {
        region: settings.langsmithRegion,
        project: settings.langsmithProject,
        apiKey: cachedLangsmithApiKeyRef.current,
        includeContent: settings.langsmithIncludeContent,
      } as const : undefined;

      if (langsmithConfig) {
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
            ? { message: fallbackReason ?? "format fallback", status: formatErrorStatus }
            : undefined,
        });
      }

      await invoke("paste_text", { text: formatted, method: settings.inputMethod });
      logInfo("overlay.handleStop", "pasted", { method: settings.inputMethod, textLen: formatted.length });
      dispatch({ type: "FORMAT_DONE", fallback, fallbackReason });

      // paste 後に非同期で話題コンテキストを更新（レイテンシに影響させない）。
      // fallback（整形失敗で生テキスト）時は誤りを取り込まないよう蒸留しない。
      if (win && !fallback) {
        void refreshContext(win.id, win.exe, win.title, formatted, {
          formatProvider: settings.formatProvider,
          endpoint: settings.formatEndpoint,
          apiKey: cachedFormatApiKeyRef.current,
          model: formatModel,
          reasoningEffort: settings.reasoningEffort,
        }, langsmithConfig);
      }
    } catch (e) {
      // AbortError はキャンセルなので即非表示（フェード不要）
      if (e instanceof DOMException && e.name === "AbortError") {
        // 再操作による中断。貼り付けまで到達しなかった理由をブレッドクラムとして残す。
        logInfo("overlay.handleStop", "cancelled by user (re-trigger during processing)", {
          hadTranscript: !!rawTranscript,
          transcriptLen: rawTranscript.length,
          formatted: formattedText !== "",
        });
        const appWindow = getCurrentWebviewWindow();
        await appWindow.hide();
        dispatch({ type: "ABORT_CANCELLED" });
        return;
      }
      stopError = e;
      logError("overlay.handleStop", "stop failed", e);
      dispatch({ type: "STOP_ERROR", errorMsg: toUserMessage(e) });
    } finally {
      endProcessing();
      const configuredFolder = settings.logFolder.trim();
      const hasError = stopError !== null && formattedText === "";
      // 設定フォルダがある → 全ログ出力。設定なし + エラー → デフォルトパスにエラーログのみ出力
      if (rawTranscript || hasError) {
        await trySaveLog(configuredFolder, now, {
          transcription: rawTranscript,
          formatted: formattedText,
          ...(win ? { window: { exe: win.exe, title: win.title } } : {}),
          ...(injectedContext ? { topic: injectedContext } : {}),
          ...(hasError ? { error: formatError(stopError) } : {}),
        });
      }
    }
  };

  // nospeech（無音終端）は表示上は recording と同じ「listening」系で扱い、現行の見た目を温存する。
  const isRecordingLike = phase === "recording" || phase === "nospeech";

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
    isRecordingLike
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
    isRecordingLike
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
      </div>
    </div>
  );
}

