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

function encodeWav(samples: Float32Array[], inputSampleRate: number): Blob {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;

  // ダウンサンプリング後のサンプル数を計算
  const totalInput = samples.reduce((sum, buf) => sum + buf.length, 0);
  const totalOutput = Math.floor(totalInput / ratio);

  // 全バッファを1つの Float32Array に結合してランダムアクセス可能にする
  const flat = new Float32Array(totalInput);
  let offset = 0;
  for (const buf of samples) {
    flat.set(buf, offset);
    offset += buf.length;
  }

  const pcm = new Int16Array(totalOutput);
  for (let i = 0; i < totalOutput; i++) {
    const srcIdx = i * ratio;
    const srcFloor = Math.floor(srcIdx);
    const frac = srcIdx - srcFloor;
    const s0 = flat[srcFloor] ?? 0;
    const s1 = flat[srcFloor + 1] ?? 0;
    const sample = s0 + frac * (s1 - s0);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }

  const dataBytes = pcm.buffer.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  const writeU32 = (offset: number, val: number) => view.setUint32(offset, val, true);
  const writeU16 = (offset: number, val: number) => view.setUint16(offset, val, true);

  write(0, "RIFF");
  writeU32(4, 36 + dataBytes);
  write(8, "WAVE");
  write(12, "fmt ");
  writeU32(16, 16);        // chunk size
  writeU16(20, 1);         // PCM
  writeU16(22, 1);         // mono
  writeU32(24, targetRate);
  writeU32(28, targetRate * 2); // byte rate
  writeU16(32, 2);         // block align
  writeU16(34, 16);        // bits per sample
  write(36, "data");
  writeU32(40, dataBytes);

  new Int16Array(buffer, 44).set(pcm);

  return new Blob([buffer], { type: "audio/wav" });
}

export class TranscriptionSession {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private pcmSamples: Float32Array[] = [];
  private peakAudioLevel = 0;
  private provider: TranscriptionProvider = "azure-openai";
  private endpoint = "";
  private apiKey = "";
  private model = "";
  private speechEndpoint = "";
  private speechLanguage = "";

  async start(params: {
    provider: TranscriptionProvider;
    endpoint: string;
    apiKey: string;
    model: string;
    speechEndpoint: string;
    speechLanguage: string;
  }): Promise<void> {
    this.provider = params.provider;
    this.endpoint = params.endpoint;
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.speechEndpoint = params.speechEndpoint;
    this.speechLanguage = params.speechLanguage;

    if (this.provider === "azure-openai") {
      if (!this.endpoint) throw new Error("endpoint が未設定です");
      if (!this.apiKey) throw new Error("apiKey が未設定です");
      if (!this.model) throw new Error("transcriptionModel が未設定です");
    } else {
      if (!this.apiKey) throw new Error("apiKey が未設定です");
      if (!this.speechEndpoint) throw new Error("Speech エンドポイントが未設定です");
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
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

    // PCMキャプチャ（Azure Speech 用）
    this.pcmSamples = [];
    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.scriptProcessor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      this.pcmSamples.push(new Float32Array(data));
    };
    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);

    const mimeType = pickMimeType();
    this.chunks = [];
    this.peakAudioLevel = 0;
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

  async stop(): Promise<string> {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("録音セッションが開始されていません");
    this.getAudioLevel();

    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });

    // scriptProcessor の disconnect はサンプル収集完了後
    this.scriptProcessor?.disconnect();
    this.scriptProcessor = null;

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.analyser = null;
    const sampleRate = this.audioContext?.sampleRate ?? 48000;
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.peakAudioLevel < 0.2) return "";

    if (this.provider === "azure-speech") {
      const wavBlob = encodeWav(this.pcmSamples, sampleRate);
      this.pcmSamples = [];

      if (wavBlob.size <= 44) return "";

      const base = this.speechEndpoint.replace(/\/$/, "");
      const speechUrl = `${base}/speech/recognition/conversation/cognitiveservices/v1?language=${this.speechLanguage}`;
      const res = await fetch(speechUrl, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.apiKey,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        },
        body: wavBlob,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`文字起こしAPI エラー: ${res.status} ${text}`);
      }

      const data = await res.json();
      return data.RecognitionStatus === "Success" ? (data.DisplayText ?? "") : "";
    }

    // azure-openai パス（既存）
    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    this.pcmSamples = [];

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
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`文字起こしAPI エラー: ${res.status} ${text}`);
    }

    const data = await res.json();
    return typeof data?.text === "string" ? data.text : "";
  }
}
