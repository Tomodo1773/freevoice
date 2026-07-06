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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
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
  private recognizedTexts: string[] = [];
  /** 最新の暫定テキスト。recognized（確定）で空にし、recognizing（暫定）で更新する。
   *  stop 時に recognized が間に合わない環境向けのフォールバック。 */
  private lastInterimText = "";

  private stopping = false;
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
  }): Promise<void> {
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
    } else {
      if (!this.speechEndpoint) throw new Error("Speech エンドポイントが未設定です");
    }

    // 全プロバイダー共通: VU メーター用にマイク取得（外部から渡された場合は再利用）
    this.mediaStream = params.mediaStream ?? await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        ...(params.audioDeviceId ? { deviceId: { exact: params.audioDeviceId } } : {}),
      },
    });
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;
    source.connect(this.analyser);
    this.peakAudioLevel = 0;

    if (this.provider === "azure-speech") {
      this.SpeechSDK = await import("microsoft-cognitiveservices-speech-sdk");
      this.recognizedTexts = [];
      this.lastInterimText = "";
      this.stopping = false;
      this.reconnectEnabled = false;
      this.reconnectCount = 0;
      await this.startRecognizer();
      this.reconnectEnabled = true;
      return;
    }

    const mimeType = pickMimeType();
    this.chunks = [];
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.mediaStream, { mimeType })
      : new MediaRecorder(this.mediaStream);
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.mediaRecorder.start(250);
  }

  /** recognizer を安全に閉じて null にする。close() の throwIfDisposed を吸収する。 */
  private closeRecognizer(): void {
    if (this.recognizer) {
      try {
        this.recognizer.close();
      } catch {
        // close() は既に dispose 済みの場合 throwIfDisposed でスローする
      }
      this.recognizer = null;
    }
  }

  /** Azure Speech recognizer を作成・開始する。start() と attemptReconnect() の共通パス。 */
  private async startRecognizer(): Promise<void> {
    const SDK = this.SpeechSDK!;

    const speechConfig = SDK.SpeechConfig.fromEndpoint(
      new URL(this.speechEndpoint),
      this.apiKey
    );
    speechConfig.speechRecognitionLanguage = this.speechLanguage || "ja-JP";

    const audioConfig = this.audioDeviceId
      ? SDK.AudioConfig.fromMicrophoneInput(this.audioDeviceId)
      : SDK.AudioConfig.fromDefaultMicrophoneInput();

    const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizing = (_, e) => {
      if (e.result.text) {
        this.lastInterimText = e.result.text;
        this.onInterimResult?.(this.recognizedTexts.join("") + e.result.text);
      }
    };

    recognizer.recognized = (_, e) => {
      if (
        e.result.reason === SDK.ResultReason.RecognizedSpeech &&
        e.result.text
      ) {
        this.recognizedTexts.push(e.result.text);
        this.lastInterimText = "";
        this.onInterimResult?.(this.recognizedTexts.join(""));
      }
    };

    recognizer.canceled = (_, e) => {
      // 原因究明のため、どの分岐に入るかに関わらず canceled は必ず記録する。
      // 「認識中に突然止まったのにログに何も残らない」状態を根絶する。
      const diag = {
        reason: SDK.CancellationReason[e.reason] ?? e.reason,
        errorCode: SDK.CancellationErrorCode[e.errorCode] ?? e.errorCode,
        errorDetails: e.errorDetails ?? "",
        stopping: this.stopping,
        reconnectEnabled: this.reconnectEnabled,
        reconnectCount: this.reconnectCount,
        recognizedCount: this.recognizedTexts.length,
        hadInterim: !!this.lastInterimText,
      };

      // stop() 由来の canceled（正常終了）は情報ログのみ
      if (this.stopping) {
        logInfo("transcription.canceled", "canceled during stop (normal)", diag);
        return;
      }
      // 初回接続確立前の canceled は start() 側の reject に委ねる（二重処理を防ぐ）
      if (!this.reconnectEnabled) {
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
        this.onRecognitionError?.("音声認識が切断されました");
        return;
      }

      logWarn("transcription.canceled", "recognition interrupted mid-recording, will reconnect", diag);
      if (this.reconnectPromise) return;
      void this.attemptReconnect(e.errorCode, e.errorDetails ?? "");
    };

    // セッションがサービス側で終了した際の痕跡を必ず残す。
    // stop() 由来（正常終了）は記録しないが、録音中の予期しない終了は WARN で残し、
    // canceled が発火しないケースでも「認識が黙って止まった」ことを追えるようにする。
    recognizer.sessionStopped = (_, e) => {
      if (this.stopping) return;
      logWarn("transcription.sessionStopped", "session stopped unexpectedly mid-recording", {
        sessionId: e.sessionId,
        recognizedCount: this.recognizedTexts.length,
        reconnectCount: this.reconnectCount,
      });
    };

    this.recognizer = recognizer;

    await new Promise<void>((resolve, reject) => {
      recognizer.startContinuousRecognitionAsync(resolve, reject);
    });
  }

  /** 一時的エラーからの再接続。蓄積テキストを保持し、暫定テキストを昇格させてから再開する。 */
  private async attemptReconnect(errorCode: number, errorDetails: string): Promise<void> {
    this.reconnectCount++;
    logWarn("transcription.canceled", `reconnecting (${this.reconnectCount}/${TranscriptionSession.MAX_RECONNECTS})`, {
      errorCode,
      errorDetails,
    });

    if (this.lastInterimText) {
      this.recognizedTexts.push(this.lastInterimText);
      this.lastInterimText = "";
      this.onInterimResult?.(this.recognizedTexts.join(""));
    }

    this.closeRecognizer();

    this.reconnectPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, TranscriptionSession.RECONNECT_DELAY_MS));
      if (this.stopping) return;
      try {
        await this.startRecognizer();
        this.reconnectCount = 0;
        logInfo("transcription.canceled", "reconnected successfully");
      } catch (e) {
        logError("transcription.canceled", "reconnection failed", e, {
          reconnectCount: this.reconnectCount,
        });
        this.closeRecognizer();
        if (this.reconnectCount >= TranscriptionSession.MAX_RECONNECTS) {
          this.onRecognitionError?.("音声認識が切断されました");
        }
      }
    })();
    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
  }

  getAudioLevel(): number {
    if (!this.analyser) return 0;
    const levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.analyser.getByteFrequencyData(levelBuffer);
    let sum = 0;
    for (const value of levelBuffer) sum += value;
    const level = sum / levelBuffer.length / 255;
    this.peakAudioLevel = Math.max(this.peakAudioLevel, level);
    return level;
  }

  get wasSilent(): boolean {
    return this.peakAudioLevel < TranscriptionSession.SILENCE_THRESHOLD;
  }

  /** mediaStream / analyser / audioContext を解放する。
   *  audioContext.close() は await せず投げっぱなしにして return を遅らせない。
   *  解放対象は確定済みの最終テキストに影響せず、次回録音は新しい AudioContext を作る。 */
  private releaseAudioResources(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.analyser = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  async stop(signal?: AbortSignal): Promise<string> {
    // 共通: peakAudioLevel 最終更新
    this.getAudioLevel();

    if (this.provider === "azure-speech") {
      this.stopping = true;

      if (this.reconnectPromise) {
        await withTimeout(this.reconnectPromise, TranscriptionSession.RECONNECT_TIMEOUT_MS)
          .catch((e) => {
            // 再接続が stop 時点で終わらずタイムアウト。テキスト取りこぼしの手掛かりになる。
            logWarn("transcription.stop", "reconnect did not settle before stop", { error: e });
          });
      }

      if (this.recognizer) {
        try {
          const recognizer = this.recognizer;
          await new Promise<void>((resolve, reject) => {
            recognizer.stopContinuousRecognitionAsync(resolve, reject);
          });
        } catch (e) {
          // recognizer が不正な状態の場合 stopContinuousRecognitionAsync が失敗しうる
          logWarn("transcription.stop", "stopContinuousRecognitionAsync failed", { error: e });
        }
      }
      this.closeRecognizer();

      this.releaseAudioResources();

      // stopContinuousRecognitionAsync と `recognized` イベント配信の間にはレースがあり、
      // ユーザーが発話中にキーを離すと recognized が届かず recognizedTexts が空になる環境がある。
      // その場合は最新の暫定テキストをフォールバックとして採用し、無言で録音を落とさない。
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
      // 確定・暫定ともに空。音声レベルの痕跡を残し、無音なのか認識喪失なのかを切り分ける。
      logWarn("transcription.stop", "azure-speech produced no text", {
        peakAudioLevel: Number(this.peakAudioLevel.toFixed(3)),
        wasSilent: this.wasSilent,
        reconnectCount: this.reconnectCount,
      });
      return "";
    }

    // azure-openai パス
    this.releaseAudioResources();

    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("録音セッションが開始されていません");

    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });

    this.mediaRecorder = null;

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
      // 無音ではないのに録音データが空。マイク供給停止などの異常なので WARN で残す。
      logWarn("transcription.stop", "azure-openai empty recording blob", {
        mimeType,
        peakAudioLevel: Number(this.peakAudioLevel.toFixed(3)),
      });
      return "";
    }

    const form = new FormData();
    form.append("model", this.model);
    form.append("file", blob, `recording.${extensionForMimeType(mimeType)}`);

    const transcriptionUrl = buildAzureTranscriptionUrl(this.endpoint, this.model);
    const res = await fetch(transcriptionUrl, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
      },
      body: form,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`文字起こしAPI エラー: ${res.status} ${text}`);
    }

    const data = await res.json();
    if (typeof data?.text !== "string") {
      // API は 2xx だが期待した形（text フィールド）で返らなかった。空返しの理由を残す。
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
  }
}
