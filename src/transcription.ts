import type * as SpeechSDKTypes from "microsoft-cognitiveservices-speech-sdk";
import { buildAzureTranscriptionUrl } from "./azureOpenaiEndpoint";
import { TranscriptionProvider } from "./types";
import { logInfo, logWarn, logError } from "./diagLog";

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

type LifecycleState = "new" | "starting" | "running" | "stopping" | "disposed";

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function signalReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? abortError(fallback);
}

/**
 * AbortSignal と期限を、キャンセル非対応のブラウザ/SDK Promise に被せる。
 * 元 Promise の完了ハンドラは残るため、後から reject しても unhandled rejection にならない。
 */
function awaitOperation<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(signalReason(options.signal!, "処理はキャンセルされました")));

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeoutId = setTimeout(
        () => finish(() => reject(new Error(options.timeoutMessage ?? "処理がタイムアウトしました"))),
        options.timeoutMs,
      );
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return awaitOperation(new Promise<void>((resolve) => setTimeout(resolve, ms)), { signal });
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  let tracks: MediaStreamTrack[];
  try {
    tracks = stream.getTracks();
  } catch {
    return;
  }
  tracks.forEach((track) => {
    try {
      track.stop();
    } catch {
      // 一部のブラウザ実装は既に終了済みの track.stop() で例外を返す
    }
  });
}

function linkAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => !!signal);
  const listeners = active.map((source) => {
    const listener = () => controller.abort(signalReason(source, "処理はキャンセルされました"));
    if (source.aborted) listener();
    else source.addEventListener("abort", listener, { once: true });
    return { source, listener };
  });
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(({ source, listener }) =>
      source.removeEventListener("abort", listener)),
  };
}

export class TranscriptionSession {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private peakAudioLevel = 0;
  private static readonly SILENCE_THRESHOLD = 0.05;
  private static readonly MAX_RECONNECTS = 3;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly RECONNECT_TIMEOUT_MS = 5000;
  /** getUserMedia、SDK import、認識開始を含む start() 全体の上限。 */
  private static readonly START_TIMEOUT_MS = 15000;
  private static readonly RECOGNIZER_START_TIMEOUT_MS = 8000;
  /** Speech SDK の停止コールが応答しなくても formatting へ進むための上限。 */
  private static readonly STOP_TIMEOUT_MS = 4000;
  /** SDK内部にも期限を設定し、timeout時に接続を強制切断させる。 */
  private static readonly SDK_STOP_TIMEOUT_MS = 3000;
  private static readonly RECOGNIZER_CLOSE_TIMEOUT_MS = 3000;
  private static readonly AUDIO_CONFIG_CLOSE_TIMEOUT_MS = 1000;
  private static readonly AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1000;

  private provider: TranscriptionProvider = "azure-openai";
  private endpoint = "";
  private apiKey = "";
  private model = "";
  private speechEndpoint = "";
  private speechLanguage = "";
  private audioDeviceId = "";
  private onInterimResult?: (text: string) => void;
  private onRecognitionError?: (message: string) => void;

  private SpeechSDK: typeof SpeechSDKTypes | null = null;
  private recognizer: SpeechSDKTypes.SpeechRecognizer | null = null;
  private speechAudioConfig: SpeechSDKTypes.AudioConfig | null = null;
  private readonly recognizerClosures = new WeakMap<
    SpeechSDKTypes.SpeechRecognizer,
    Promise<void>
  >();
  /** 参照をnull化した後も、旧SDK資源のclose完了をdispose側から待てるよう保持する。 */
  private pendingRecognizerClose: Promise<void> = Promise.resolve();
  private recognizedTexts: string[] = [];
  /** 最新の暫定テキスト。recognized（確定）で空にし、recognizing（暫定）で更新する。
   *  stop 時に recognized が間に合わない環境向けのフォールバック。 */
  private lastInterimText = "";

  /** ライフサイクルは後戻りさせない。セッションは一度だけ使用する。 */
  private lifecycle: LifecycleState = "new";
  private startAbortController: AbortController | null = null;
  private readonly reconnectAbortController = new AbortController();
  /** 通常の stop では abort せず、外部 dispose との競合時だけ upload 等を中止する。 */
  private readonly disposeAbortController = new AbortController();
  private stopPromise: Promise<string> | null = null;
  private disposePromise: Promise<void> | null = null;
  private stopResult = "";
  /** 初回 startRecognizer 成功後にのみ true。start() 中の canceled+reject 二重発火によるリークを防ぐ。 */
  private reconnectEnabled = false;
  private reconnectCount = 0;
  private reconnectPromise: Promise<void> | null = null;

  async start(params: {
    provider: TranscriptionProvider;
    endpoint: string;
    apiKey: string;
    model: string;
    speechEndpoint: string;
    speechLanguage: string;
    audioDeviceId?: string;
    mediaStream?: MediaStream;
    onInterimResult?: (text: string) => void;
    onRecognitionError?: (message: string) => void;
  }, signal?: AbortSignal): Promise<void> {
    if (this.lifecycle !== "new") {
      throw new Error("録音セッションは一度だけ開始できます");
    }
    this.lifecycle = "starting";

    const startController = new AbortController();
    this.startAbortController = startController;
    const forwardAbort = () =>
      startController.abort(signalReason(signal!, "録音開始はキャンセルされました"));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const startTimeout = setTimeout(
      () => startController.abort(new Error("録音開始がタイムアウトしました")),
      TranscriptionSession.START_TIMEOUT_MS,
    );

    try {
      this.provider = params.provider;
      this.endpoint = params.endpoint;
      this.apiKey = params.apiKey;
      this.model = params.model;
      this.speechEndpoint = params.speechEndpoint;
      this.speechLanguage = params.speechLanguage;
      this.audioDeviceId = params.audioDeviceId ?? "";
      this.onInterimResult = params.onInterimResult;
      this.onRecognitionError = params.onRecognitionError;

      if (!this.apiKey) throw new Error("apiKey が未設定です");
      if (this.provider === "azure-openai") {
        if (!this.endpoint) throw new Error("endpoint が未設定です");
        if (!this.model) throw new Error("transcriptionModel が未設定です");
      } else if (!this.speechEndpoint) {
        throw new Error("Speech エンドポイントが未設定です");
      }
      this.throwIfStartCanceled(startController.signal);

      // getUserMedia 自体はキャンセル不能。遅れて解決した場合も、その場で track を止める。
      const streamPromise = params.mediaStream
        ? Promise.resolve(params.mediaStream)
        : navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              noiseSuppression: true,
              echoCancellation: true,
              ...(params.audioDeviceId ? { deviceId: { exact: params.audioDeviceId } } : {}),
            },
          });
      void streamPromise.then((stream) => {
        if (this.lifecycle !== "starting" || startController.signal.aborted) {
          stopStream(stream);
        }
      }).catch(() => {});
      const stream = await awaitOperation(streamPromise, { signal: startController.signal });
      this.throwIfStartCanceled(startController.signal);
      this.mediaStream = stream;

      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.7;
      source.connect(this.analyser);
      this.peakAudioLevel = 0;

      if (this.provider === "azure-speech") {
        const SDK = await awaitOperation(
          import("microsoft-cognitiveservices-speech-sdk"),
          { signal: startController.signal },
        );
        this.throwIfStartCanceled(startController.signal);
        this.SpeechSDK = SDK;
        this.recognizedTexts = [];
        this.lastInterimText = "";
        this.reconnectEnabled = false;
        this.reconnectCount = 0;
        await this.startRecognizer(startController.signal);
        this.throwIfStartCanceled(startController.signal);
        this.reconnectEnabled = true;
      } else {
        const mimeType = pickMimeType();
        this.chunks = [];
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        this.mediaRecorder = recorder;
        recorder.ondataavailable = (event) => {
          if (this.mediaRecorder === recorder && this.lifecycle !== "disposed" && event.data.size > 0) {
            this.chunks.push(event.data);
          }
        };
        recorder.start(250);
        this.throwIfStartCanceled(startController.signal);
      }

      this.lifecycle = "running";
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      clearTimeout(startTimeout);
      signal?.removeEventListener("abort", forwardAbort);
      if (this.startAbortController === startController) this.startAbortController = null;
    }
  }

  private throwIfStartCanceled(signal: AbortSignal): void {
    if (signal.aborted) throw signalReason(signal, "録音開始はキャンセルされました");
    if (this.lifecycle !== "starting") throw abortError("録音開始はキャンセルされました");
  }

  /** recognizer とSDK側マイクを切り離し、非同期close完了まで期限付きで待つ。 */
  private closeRecognizer(): Promise<void> {
    const recognizer = this.recognizer;
    const audioConfig = this.speechAudioConfig;
    this.recognizer = null;
    this.speechAudioConfig = null;
    if (!recognizer) {
      const pending = Promise.all([
        this.pendingRecognizerClose,
        this.closeAudioConfig(audioConfig),
      ]).then(() => undefined);
      this.pendingRecognizerClose = pending;
      return pending;
    }
    return this.closeRecognizerInstance(recognizer, audioConfig);
  }

  private closeRecognizerInstance(
    recognizer: SpeechSDKTypes.SpeechRecognizer,
    audioConfig: SpeechSDKTypes.AudioConfig | null,
  ): Promise<void> {
    const existing = this.recognizerClosures.get(recognizer);
    if (existing) return this.pendingRecognizerClose;

    const closing = (async () => {
      // close() 後に SDK がイベントを配送しても、セッション外へ通知しない。
      try {
        recognizer.recognizing = () => {};
        recognizer.recognized = () => {};
        recognizer.canceled = () => {};
        recognizer.sessionStopped = () => {};
      } catch {
        // SDK 内部状態にかかわらず close() は試す
      }

      try {
        await awaitOperation(
          new Promise<void>((resolve, reject) => {
            try {
              recognizer.close(resolve, (error) => reject(new Error(error)));
            } catch {
              // close() は既にdispose済みの場合throwする。資源解放済みとして扱う。
              resolve();
            }
          }),
          {
            timeoutMs: TranscriptionSession.RECOGNIZER_CLOSE_TIMEOUT_MS,
            timeoutMessage: "Azure Speech recognizer の破棄がタイムアウトしました",
          },
        );
      } catch (error) {
        logWarn("transcription.dispose", "recognizer close did not settle", { error });
      } finally {
        // recognizer.disposeが途中で失敗しても、AudioConfigを直接閉じてSDK側マイクを解放する。
        await this.closeAudioConfig(audioConfig);
      }
    })();
    this.recognizerClosures.set(recognizer, closing);
    const pending = Promise.all([
      this.pendingRecognizerClose,
      closing,
    ]).then(() => undefined);
    this.pendingRecognizerClose = pending;
    return pending;
  }

  private async closeAudioConfig(
    audioConfig: SpeechSDKTypes.AudioConfig | null,
  ): Promise<void> {
    if (!audioConfig) return;
    try {
      await awaitOperation(
        new Promise<void>((resolve, reject) => {
          try {
            const close = audioConfig.close.bind(audioConfig) as unknown as (
              done: () => void,
              failed: (error: string) => void,
            ) => void;
            close(resolve, (error) => reject(new Error(error)));
          } catch {
            resolve();
          }
        }),
        {
          timeoutMs: TranscriptionSession.AUDIO_CONFIG_CLOSE_TIMEOUT_MS,
          timeoutMessage: "Azure Speech audio config の破棄がタイムアウトしました",
        },
      );
    } catch (error) {
      logWarn("transcription.dispose", "audio config close did not settle", { error });
    }
  }

  private isCurrentRecognizer(
    recognizer: SpeechSDKTypes.SpeechRecognizer,
    allowStopping = false,
  ): boolean {
    return this.recognizer === recognizer && (
      this.lifecycle === "starting" ||
      this.lifecycle === "running" ||
      (allowStopping && this.lifecycle === "stopping")
    );
  }

  /** Azure Speech recognizer を作成・開始する。初回開始と再接続の共通パス。 */
  private async startRecognizer(signal: AbortSignal): Promise<void> {
    if (signal.aborted || (this.lifecycle !== "starting" && this.lifecycle !== "running")) {
      throw signal.aborted
        ? signalReason(signal, "録音開始はキャンセルされました")
        : abortError("録音開始はキャンセルされました");
    }
    const SDK = this.SpeechSDK;
    if (!SDK) throw new Error("Speech SDK が読み込まれていません");

    const speechConfig = SDK.SpeechConfig.fromEndpoint(
      new URL(this.speechEndpoint),
      this.apiKey
    );
    speechConfig.speechRecognitionLanguage = this.speechLanguage || "ja-JP";
    speechConfig.setProperty(
      SDK.PropertyId.Recognizer_StopTimeoutMs,
      String(TranscriptionSession.SDK_STOP_TIMEOUT_MS),
    );

    const audioConfig = this.audioDeviceId
      ? SDK.AudioConfig.fromMicrophoneInput(this.audioDeviceId)
      : SDK.AudioConfig.fromDefaultMicrophoneInput();

    const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizing = (_, e) => {
      if (this.isCurrentRecognizer(recognizer) && e.result.text) {
        this.lastInterimText = e.result.text;
        this.onInterimResult?.(this.recognizedTexts.join("") + e.result.text);
      }
    };

    recognizer.recognized = (_, e) => {
      if (
        this.isCurrentRecognizer(recognizer, true) &&
        e.result.reason === SDK.ResultReason.RecognizedSpeech &&
        e.result.text
      ) {
        this.recognizedTexts.push(e.result.text);
        this.lastInterimText = "";
        this.onInterimResult?.(this.recognizedTexts.join(""));
      }
    };

    recognizer.canceled = (_, e) => {
      if (!this.isCurrentRecognizer(recognizer, true)) return;
      // 原因究明のため、どの分岐に入るかに関わらず canceled は必ず記録する。
      // 「認識中に突然止まったのにログに何も残らない」状態を根絶する。
      const diag = {
        reason: SDK.CancellationReason[e.reason] ?? e.reason,
        errorCode: SDK.CancellationErrorCode[e.errorCode] ?? e.errorCode,
        errorDetails: e.errorDetails ?? "",
        lifecycle: this.lifecycle,
        reconnectEnabled: this.reconnectEnabled,
        reconnectCount: this.reconnectCount,
        recognizedCount: this.recognizedTexts.length,
        hadInterim: !!this.lastInterimText,
      };

      // stop() 由来の canceled（正常終了）は情報ログのみ
      if (this.lifecycle === "stopping") {
        logInfo("transcription.canceled", "canceled during stop (normal)", diag);
        return;
      }
      // 初回接続確立前の canceled は start() 側の reject に委ねる（二重処理を防ぐ）
      if (this.lifecycle !== "running" || !this.reconnectEnabled) {
        logWarn("transcription.canceled", "canceled before recognizer ready", diag);
        return;
      }

      // 録音中の中断。Error（接続失敗・サービス側の一時障害）に加え、
      // EndOfStream（サービス/ネットワークがストリームを閉じた）も再接続対象とする。
      // マイク入力は stop するまで終端しないため、録音中の EndOfStream は異常であり、
      // これを握り潰していたことがシナリオ2（途中から認識されない）の原因だった。
      const retryable =
        e.reason === SDK.CancellationReason.EndOfStream ||
        (e.reason === SDK.CancellationReason.Error &&
          (e.errorCode === SDK.CancellationErrorCode.ConnectionFailure ||
            e.errorCode === SDK.CancellationErrorCode.ServiceTimeout ||
            e.errorCode === SDK.CancellationErrorCode.ServiceError ||
            e.errorCode === SDK.CancellationErrorCode.RuntimeError));

      if (!retryable || this.reconnectCount >= TranscriptionSession.MAX_RECONNECTS) {
        logError(
          "transcription.canceled",
          "recognition canceled mid-recording (giving up)",
          new Error(e.errorDetails || `reason=${diag.reason}`),
          diag,
        );
        this.failRecognition("音声認識が切断されました");
        return;
      }

      logWarn("transcription.canceled", "recognition interrupted mid-recording, will reconnect", diag);
      this.scheduleReconnect(e.errorCode, e.errorDetails ?? "");
    };

    // セッションがサービス側で終了した際の痕跡を必ず残す。
    // stop() 由来（正常終了）は記録しないが、録音中の予期しない終了は WARN で残し、
    // canceled が発火しないケースでも「認識が黙って止まった」ことを追えるようにする。
    recognizer.sessionStopped = (_, e) => {
      if (!this.isCurrentRecognizer(recognizer) || this.lifecycle !== "running") return;
      logWarn("transcription.sessionStopped", "session stopped unexpectedly mid-recording", {
        sessionId: e.sessionId,
        recognizedCount: this.recognizedTexts.length,
        reconnectCount: this.reconnectCount,
      });
    };

    this.recognizer = recognizer;
    this.speechAudioConfig = audioConfig;

    try {
      await awaitOperation(
        new Promise<void>((resolve, reject) => {
          recognizer.startContinuousRecognitionAsync(resolve, reject);
        }),
        {
          signal,
          timeoutMs: TranscriptionSession.RECOGNIZER_START_TIMEOUT_MS,
          timeoutMessage: "Azure Speech の認識開始がタイムアウトしました",
        },
      );
      if (!this.isCurrentRecognizer(recognizer) || signal.aborted) {
        throw signal.aborted
          ? signalReason(signal, "録音開始はキャンセルされました")
          : abortError("録音開始はキャンセルされました");
      }
    } catch (error) {
      if (this.recognizer === recognizer) {
        this.recognizer = null;
        this.speechAudioConfig = null;
      }
      await this.closeRecognizerInstance(recognizer, audioConfig);
      throw error;
    }
  }

  /** 一時的エラーからの再接続を一つだけ起動する。 */
  private scheduleReconnect(errorCode: number, errorDetails: string): void {
    if (this.reconnectPromise || this.lifecycle !== "running") return;
    if (this.lastInterimText) {
      this.recognizedTexts.push(this.lastInterimText);
      this.lastInterimText = "";
      this.onInterimResult?.(this.recognizedTexts.join(""));
    }
    const closePromise = this.closeRecognizer();

    const reconnectPromise = this.runReconnect(errorCode, errorDetails, closePromise);
    this.reconnectPromise = reconnectPromise;
    void reconnectPromise.finally(() => {
      if (this.reconnectPromise === reconnectPromise) this.reconnectPromise = null;
    }).catch(() => {});
  }

  private async runReconnect(
    errorCode: number,
    errorDetails: string,
    previousClose: Promise<void>,
  ): Promise<void> {
    const signal = this.reconnectAbortController.signal;
    await previousClose;
    while (this.lifecycle === "running" && this.reconnectCount < TranscriptionSession.MAX_RECONNECTS) {
      this.reconnectCount++;
      logWarn(
        "transcription.canceled",
        `reconnecting (${this.reconnectCount}/${TranscriptionSession.MAX_RECONNECTS})`,
        { errorCode, errorDetails },
      );
      try {
        await delay(TranscriptionSession.RECONNECT_DELAY_MS, signal);
        if (this.lifecycle !== "running") return;
        await this.startRecognizer(signal);
        this.reconnectCount = 0;
        logInfo("transcription.canceled", "reconnected successfully");
        return;
      } catch (error) {
        await this.closeRecognizer();
        if (signal.aborted || this.lifecycle !== "running") return;
        logError("transcription.canceled", "reconnection failed", error, {
          reconnectCount: this.reconnectCount,
        });
      }
    }
    if (this.lifecycle === "running") this.failRecognition("音声認識が切断されました");
  }

  private failRecognition(message: string): void {
    if (this.lifecycle !== "running") return;
    const callback = this.onRecognitionError;
    callback?.(message);
    // callback の有無に依存せず、認識不能になったセッションの資源は回収する。
    void this.dispose();
  }

  getAudioLevel(): number {
    if (!this.analyser) return 0;
    try {
      const levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      this.analyser.getByteFrequencyData(levelBuffer);
      let sum = 0;
      for (const value of levelBuffer) sum += value;
      const level = sum / levelBuffer.length / 255;
      this.peakAudioLevel = Math.max(this.peakAudioLevel, level);
      return level;
    } catch {
      return 0;
    }
  }

  get wasSilent(): boolean {
    return this.peakAudioLevel < TranscriptionSession.SILENCE_THRESHOLD;
  }

  /** mediaStream / analyser / audioContext を best-effort で解放する。 */
  private async releaseAudioResources(): Promise<void> {
    stopStream(this.mediaStream);
    this.mediaStream = null;
    this.analyser = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (!context) return;
    try {
      await awaitOperation(context.close(), {
        timeoutMs: TranscriptionSession.AUDIO_CONTEXT_CLOSE_TIMEOUT_MS,
        timeoutMessage: "AudioContext の終了がタイムアウトしました",
      });
    } catch {
      // close() は既に closed の場合などに例外を返すことがある
    }
  }

  stop(signal?: AbortSignal): Promise<string> {
    if (this.stopPromise) return this.stopPromise;
    if (this.lifecycle === "disposed") return Promise.resolve(this.stopResult);

    // 状態変更とキャンセルは最初の await より前に行い、start/reconnect の追い越しを防ぐ。
    this.lifecycle = "stopping";
    this.reconnectEnabled = false;
    this.startAbortController?.abort(abortError("録音停止により開始を中止しました"));
    this.reconnectAbortController.abort(abortError("録音を停止しました"));

    const promise = this.performStop(signal);
    this.stopPromise = promise;
    return promise;
  }

  private async performStop(signal?: AbortSignal): Promise<string> {
    try {
      this.getAudioLevel();
      const result = this.provider === "azure-speech"
        ? await this.stopAzureSpeech(signal)
        : await this.stopAzureOpenAI(signal);
      this.stopResult = result;
      return result;
    } finally {
      await this.beginDisposed(false);
    }
  }

  private async stopAzureSpeech(signal?: AbortSignal): Promise<string> {
    const linked = linkAbortSignals([signal, this.disposeAbortController.signal]);
    try {
      if (this.reconnectPromise) {
        await awaitOperation(this.reconnectPromise, {
          signal: linked.signal,
          timeoutMs: TranscriptionSession.RECONNECT_TIMEOUT_MS,
          timeoutMessage: "再接続の終了待ちがタイムアウトしました",
        }).catch((error) => {
          logWarn("transcription.stop", "reconnect did not settle before stop", { error });
        });
      }

      const recognizer = this.recognizer;
      if (recognizer) {
        try {
          await awaitOperation(
            new Promise<void>((resolve, reject) => {
              recognizer.stopContinuousRecognitionAsync(resolve, reject);
            }),
            {
              signal: linked.signal,
              timeoutMs: TranscriptionSession.STOP_TIMEOUT_MS,
              timeoutMessage: "Azure Speech の認識停止がタイムアウトしました",
            },
          );
        } catch (error) {
          logWarn("transcription.stop", "stopContinuousRecognitionAsync failed", { error });
        }
      }
      await Promise.all([
        this.closeRecognizer(),
        this.releaseAudioResources(),
      ]);

      // stop と recognized 配送のレースに備え、確定が無ければ最新の暫定を採用する。
      const finalText = this.recognizedTexts.join("");
      if (finalText) {
        logInfo("transcription.stop", "azure-speech final text ready", {
          recognizedCount: this.recognizedTexts.length,
          finalLen: finalText.length,
          reconnectCount: this.reconnectCount,
        });
        return finalText;
      }
      if (this.lastInterimText) {
        logWarn("transcription.stop", "azure-speech interim fallback used", {
          interimLen: this.lastInterimText.length,
          reconnectCount: this.reconnectCount,
        });
        return this.lastInterimText;
      }
      logWarn("transcription.stop", "azure-speech produced no text", {
        peakAudioLevel: Number(this.peakAudioLevel.toFixed(3)),
        wasSilent: this.wasSilent,
        reconnectCount: this.reconnectCount,
      });
      return "";
    } finally {
      linked.cleanup();
    }
  }

  private async stopAzureOpenAI(signal?: AbortSignal): Promise<string> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      await this.releaseAudioResources();
      return "";
    }

    await this.stopMediaRecorder(recorder);
    if (this.mediaRecorder === recorder) this.mediaRecorder = null;
    await this.releaseAudioResources();

    if (this.wasSilent) {
      logInfo("transcription.stop", "azure-openai silent, skipping upload", {
        peakAudioLevel: Number(this.peakAudioLevel.toFixed(3)),
      });
      return "";
    }

    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    if (blob.size === 0) {
      logWarn("transcription.stop", "azure-openai empty recording blob", {
        mimeType,
        peakAudioLevel: Number(this.peakAudioLevel.toFixed(3)),
      });
      return "";
    }

    const form = new FormData();
    form.append("model", this.model);
    form.append("file", blob, `recording.${extensionForMimeType(mimeType)}`);
    const linked = linkAbortSignals([signal, this.disposeAbortController.signal]);
    try {
      const res = await fetch(buildAzureTranscriptionUrl(this.endpoint, this.model), {
        method: "POST",
        headers: { "api-key": this.apiKey },
        body: form,
        signal: linked.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`文字起こしAPI エラー: ${res.status} ${text}`);
      }
      const data = await res.json();
      if (typeof data?.text !== "string") {
        logWarn("transcription.stop", "azure-openai response missing text field", {
          blobSize: blob.size,
        });
        return "";
      }
      logInfo("transcription.stop", "azure-openai transcription received", {
        textLen: data.text.length,
        blobSize: blob.size,
      });
      return data.text;
    } finally {
      linked.cleanup();
    }
  }

  private async stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
    try {
      if (recorder.state === "inactive") {
        recorder.ondataavailable = null;
        return;
      }
      await awaitOperation(
        new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        }),
        {
          timeoutMs: TranscriptionSession.STOP_TIMEOUT_MS,
          timeoutMessage: "MediaRecorder の停止がタイムアウトしました",
        },
      );
    } catch (error) {
      logWarn("transcription.stop", "MediaRecorder stop failed", { error });
    } finally {
      try {
        recorder.ondataavailable = null;
      } catch {
        // 既に破棄された recorder でも解放処理は継続する
      }
    }
  }

  /**
   * どの状態からでも、何度でも安全に呼べる最終解放。
   * stop() と競合した場合は SDK 待ちや upload も中止し、資源回収を優先する。
   */
  dispose(): Promise<void> {
    return this.beginDisposed(true);
  }

  private beginDisposed(abortPendingWork: boolean): Promise<void> {
    this.lifecycle = "disposed";
    this.reconnectEnabled = false;
    this.startAbortController?.abort(abortError("録音セッションを破棄しました"));
    this.reconnectAbortController.abort(abortError("録音セッションを破棄しました"));
    if (abortPendingWork) {
      this.disposeAbortController.abort(abortError("録音セッションを破棄しました"));
    }
    this.onInterimResult = undefined;
    this.onRecognitionError = undefined;

    if (!this.disposePromise) this.disposePromise = this.releaseAllResources();
    return this.disposePromise;
  }

  private async releaseAllResources(): Promise<void> {
    // 先に参照を外すことで、close() が同期的にイベントを発火しても無効になる。
    const recognizerRelease = this.closeRecognizer();
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;
    // track停止は同期的に先行させる。MediaRecorder/AudioContextが応答しなくても
    // dispose 呼び出し後にマイクを保持し続けない。
    const audioRelease = this.releaseAudioResources();
    await Promise.all([
      recognizerRelease,
      recorder ? this.stopMediaRecorder(recorder) : Promise.resolve(),
      audioRelease,
    ]);

    const reconnect = this.reconnectPromise;
    if (reconnect) {
      await awaitOperation(reconnect, {
        timeoutMs: TranscriptionSession.RECONNECT_TIMEOUT_MS,
        timeoutMessage: "再接続処理の破棄がタイムアウトしました",
      }).catch(() => {});
    }
  }
}
