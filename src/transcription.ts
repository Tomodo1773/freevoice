import { buildAzureTranscriptionUrl } from "./azureOpenaiEndpoint";

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
  private endpoint = "";
  private apiKey = "";
  private model = "";

  async start(endpoint: string, apiKey: string, model: string): Promise<void> {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model;

    if (!this.endpoint) throw new Error("endpoint が未設定です");
    if (!this.apiKey) throw new Error("apiKey が未設定です");
    if (!this.model) throw new Error("transcriptionModel が未設定です");

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
      const finalize = () => resolve();
      recorder.addEventListener("stop", finalize, { once: true });
      recorder.stop();
    });

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.analyser = null;
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];

    if (blob.size === 0) return "";
    if (this.peakAudioLevel < 0.2) return "";

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
