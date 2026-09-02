import pcmWorkletUrl from "./pcmCapture.worklet.ts?worker&url";
import { logInfo, logWarn } from "./diagLog";
import { UserVisibleError } from "./errors";
import type { ActiveSession } from "./recorder";
import { AudioMonitor, StreamingTranscript } from "./transcription";

export const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const GEMINI_MAX_DURATION_MS = 9 * 60 * 1000;

export function scheduleGeminiMaxDuration(onElapsed: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(onElapsed, GEMINI_MAX_DURATION_MS);
}

export type GeminiServerEvent =
  | { type: "setup-complete" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "ignored" };

function qualifyModel(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export function geminiSetup(model: string, language: string): string {
  return JSON.stringify({
    setup: {
      model: qualifyModel(model),
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: {
        languageCodes: [language],
        mode: "VERBATIM",
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
      },
    },
  });
}

export const geminiActivityStart = (): string =>
  JSON.stringify({ realtimeInput: { activityStart: {} } });

export const geminiActivityEnd = (): string =>
  JSON.stringify({ realtimeInput: { activityEnd: {} } });

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function geminiAudioChunk(buffer: ArrayBuffer): string {
  return JSON.stringify({
    realtimeInput: {
      audio: {
        mimeType: "audio/pcm;rate=16000",
        data: encodeBase64(new Uint8Array(buffer)),
      },
    },
  });
}

export function parseGeminiMessage(message: string): GeminiServerEvent {
  try {
    const root = JSON.parse(message) as {
      setupComplete?: unknown;
      serverContent?: {
        inputTranscription?: { text?: unknown };
        interimInputTranscription?: { text?: unknown };
      };
    };
    if (root.setupComplete !== undefined) return { type: "setup-complete" };
    const finalText = root.serverContent?.inputTranscription?.text;
    if (typeof finalText === "string" && finalText) return { type: "final", text: finalText };
    const interimText = root.serverContent?.interimInputTranscription?.text;
    if (typeof interimText === "string" && interimText) {
      return { type: "interim", text: interimText };
    }
  } catch {
    // 認識結果以外と壊れたフレームは同じく無視する。
  }
  return { type: "ignored" };
}

type SessionState = "connecting" | "active" | "stopping" | "closed";

export class GeminiLiveSession implements ActiveSession {
  private state: SessionState = "connecting";
  private socket: WebSocket | null = null;
  private monitor: AudioMonitor | null = null;
  private worklet: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private readonly transcript = new StreamingTranscript();
  private readonly pendingAudio: string[] = [];
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<string> | null = null;
  private onInterimResult?: (text: string) => void;
  private onRecognitionError?: (message: string) => void;
  private onStopRequested?: () => void;

  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  private finalResolve!: () => void;
  private readonly finalized = new Promise<void>((resolve) => {
    this.finalResolve = resolve;
  });

  async start(params: {
    apiKey: string;
    model: string;
    language: string;
    mediaStream: MediaStream;
    onInterimResult?: (text: string) => void;
    onRecognitionError?: (message: string) => void;
    onStopRequested: () => void;
  }): Promise<void> {
    if (!params.apiKey) throw new UserVisibleError("Gemini APIキーが未設定です");
    if (!params.model) throw new UserVisibleError("Gemini文字起こしモデルが未設定です");
    if (!params.language) throw new UserVisibleError("文字起こし言語が未設定です");

    this.onInterimResult = params.onInterimResult;
    this.onRecognitionError = params.onRecognitionError;
    this.onStopRequested = params.onStopRequested;

    try {
      this.monitor = new AudioMonitor(params.mediaStream, 16000);
      await this.monitor.context.audioWorklet.addModule(pcmWorkletUrl);
      if (this.state !== "connecting") throw new DOMException("session closed", "AbortError");

      this.worklet = new AudioWorkletNode(this.monitor.context, "pcm-capture");
      this.gain = this.monitor.context.createGain();
      this.gain.gain.value = 0;
      this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        this.sendAudio(event.data);
      };
      this.monitor.source.connect(this.worklet);
      this.worklet.connect(this.gain);
      this.gain.connect(this.monitor.context.destination);
      if (this.monitor.context.state === "suspended") await this.monitor.context.resume();

      this.maxDurationTimer = scheduleGeminiMaxDuration(() => {
        if (this.state !== "active") return;
        logInfo("gemini.duration", "maximum recording duration reached");
        this.onStopRequested?.();
      });

      const query = new URLSearchParams({ key: params.apiKey });
      const socket = new WebSocket(`${GEMINI_LIVE_ENDPOINT}?${query}`);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (this.state === "connecting") socket.send(geminiSetup(params.model, params.language));
      };
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => this.handleMessage(event.data);
      socket.onerror = () => {
        logWarn("gemini.connection", "websocket error", { state: this.state });
        this.terminateConnection();
      };
      socket.onclose = (event) => {
        logInfo("gemini.connection", "websocket closed", {
          state: this.state,
          closeCode: event.code,
        });
        this.terminateConnection();
      };
    } catch (error) {
      this.releaseCapture();
      if (error instanceof UserVisibleError ||
          (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw new UserVisibleError("Gemini Liveを開始できませんでした");
    }

    return this.ready;
  }

  getAudioLevel(): number {
    return this.monitor?.getAudioLevel() ?? 0;
  }

  get wasSilent(): boolean {
    return this.monitor?.wasSilent ?? true;
  }

  stop(signal?: AbortSignal): Promise<string> {
    if (!this.stopPromise) this.stopPromise = this.finish(signal);
    return this.stopPromise;
  }

  private async finish(signal?: AbortSignal): Promise<string> {
    const wasActive = this.state === "active";
    const wasConnecting = this.state === "connecting";
    if (this.state !== "closed") this.state = "stopping";
    this.clearDurationTimer();
    this.getAudioLevel();
    this.releaseCapture();

    if (wasConnecting) this.readyReject(new DOMException("session closed", "AbortError"));
    if (wasActive) this.socket?.send(geminiActivityEnd());

    try {
      if (wasActive && this.transcript.interimText) {
        const settled = await this.waitForFinal(signal);
        if (!settled) logWarn("gemini.stop", "no final transcription within 3000ms");
      }
    } finally {
      this.state = "closed";
      const socket = this.socket;
      this.socket = null;
      socket?.close(1000);
    }
    return this.transcript.confirmedText || this.transcript.interimText;
  }

  private waitForFinal(signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => finish(false), 3000);
      const onAbort = () => {
        cleanup();
        reject(new DOMException("operation aborted", "AbortError"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (value: boolean) => {
        cleanup();
        resolve(value);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.finalized.then(() => finish(true));
    });
  }

  private sendAudio(buffer: ArrayBuffer): void {
    if (this.state === "closed" || this.state === "stopping") return;
    const message = geminiAudioChunk(buffer);
    if (this.state === "active") this.socket?.send(message);
    else this.pendingAudio.push(message);
  }

  private handleMessage(data: string | ArrayBuffer): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const event = parseGeminiMessage(text);
    switch (event.type) {
      case "setup-complete":
        if (this.state !== "connecting" || !this.socket) return;
        this.socket.send(geminiActivityStart());
        for (const message of this.pendingAudio) this.socket.send(message);
        this.pendingAudio.length = 0;
        this.state = "active";
        this.readyResolve();
        break;
      case "interim": {
        const transcript = this.transcript.observeInterim(event.text);
        if (transcript) this.onInterimResult?.(transcript);
        break;
      }
      case "final": {
        const transcript = this.transcript.confirm(event.text);
        if (transcript) this.onInterimResult?.(transcript);
        if (this.state === "stopping") this.finalResolve();
        break;
      }
      case "ignored":
        break;
    }
  }

  private terminateConnection(): void {
    const previous = this.state;
    if (previous === "closed" || previous === "stopping") return;
    this.state = "closed";
    this.clearDurationTimer();
    this.releaseCapture();
    this.pendingAudio.length = 0;
    if (previous === "connecting") {
      this.readyReject(new UserVisibleError("Gemini Liveに接続できませんでした"));
    } else {
      this.onRecognitionError?.("音声認識の接続が切断されました");
    }
  }

  private clearDurationTimer(): void {
    if (this.maxDurationTimer !== null) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
  }

  private releaseCapture(): void {
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
      this.worklet.disconnect();
      this.worklet = null;
    }
    this.gain?.disconnect();
    this.gain = null;
    this.monitor?.close();
  }
}
