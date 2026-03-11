import type * as SpeechSDKTypes from "microsoft-cognitiveservices-speech-sdk";
import { buildAzureTranscriptionUrl } from "./azureOpenaiEndpoint";
import { TranscriptionProvider } from "./types";

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

export class TranscriptionSession {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private peakAudioLevel = 0;
  private provider: TranscriptionProvider = "azure-openai";
  private endpoint = "";
  private apiKey = "";
  private model = "";
  private speechEndpoint = "";
  private speechLanguage = "";
  private recognizer: SpeechSDKTypes.SpeechRecognizer | null = null;
  private recognizedTexts: string[] = [];

  async start(params: {
    provider: TranscriptionProvider;
    endpoint: string;
    apiKey: string;
    model: string;
    speechEndpoint: string;
    speechLanguage: string;
    mediaStream?: MediaStream;
  }): Promise<void> {
    this.provider = params.provider;
    this.endpoint = params.endpoint;
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.speechEndpoint = params.speechEndpoint;
    this.speechLanguage = params.speechLanguage;

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
      const SpeechSDK = await import("microsoft-cognitiveservices-speech-sdk");
      this.recognizedTexts = [];
      const speechConfig = SpeechSDK.SpeechConfig.fromEndpoint(
        new URL(this.speechEndpoint),
        this.apiKey
      );
      speechConfig.speechRecognitionLanguage = this.speechLanguage || "ja-JP";
      const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
      this.recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
      this.recognizer.recognized = (_, e) => {
        if (
          e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          e.result.text
        ) {
          this.recognizedTexts.push(e.result.text);
        }
      };
      const recognizer = this.recognizer;
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, reject);
      });
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

  async stop(signal?: AbortSignal): Promise<string> {
    // 共通: peakAudioLevel 最終更新
    this.getAudioLevel();

    if (this.provider === "azure-speech") {
      // SDK を先に停止してからストリームを解放
      if (this.recognizer) {
        const recognizer = this.recognizer;
        await new Promise<void>((resolve, reject) => {
          recognizer.stopContinuousRecognitionAsync(resolve, reject);
        });
        recognizer.close();
        this.recognizer = null;
      }
      this.mediaStream?.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
      this.analyser = null;
      if (this.audioContext) {
        await this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      if (this.peakAudioLevel < 0.2) return "";
      return this.recognizedTexts.join("");
    }

    // azure-openai パス
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.analyser = null;
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("録音セッションが開始されていません");

    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });

    this.mediaRecorder = null;

    if (this.peakAudioLevel < 0.2) return "";

    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];

    if (blob.size === 0) return "";

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
    return typeof data?.text === "string" ? data.text : "";
  }
}
