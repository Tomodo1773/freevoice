import { invoke } from "@tauri-apps/api/core";
import { getAllApiKeys } from "./apiKeyStore";
import { logWarn } from "./diagLog";
import { warmupFormatConnection } from "./postprocess";
import type {
  CreateRecordingAttemptInput,
  ManagedRecordingAttempt,
} from "./recordingController";
import { TranscriptionSession } from "./transcription";
import type { AppSettings } from "./types";
import { loadSettings, persistSettings } from "./useSettings";

export interface CapturedWindow {
  id: string;
  exe: string;
  title: string;
}

export interface CaptureContext {
  settings: AppSettings;
  formatApiKey: string;
  langsmithApiKey: string;
  startedAt: Date;
  windowPromise: Promise<CapturedWindow | null> | null;
}

interface CaptureConfig {
  settings: AppSettings;
  apiKey: string;
  formatApiKey: string;
  langsmithApiKey: string;
}

const MUTE_IPC_WAIT_MS = 1_500;

/**
 * ミュートは補助機能なので、IPC障害で録音ライフサイクルまで止めない。
 * 元Promiseは生かしたままにし、遅延完了時のunmute連鎖は継続できるようにする。
 */
function waitForMuteIpc(promise: Promise<void>, operation: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logWarn("captureAttempt.mute", `${operation} timed out; continuing cleanup`);
      finish();
    }, MUTE_IPC_WAIT_MS);
    promise.then(finish, finish);
  });
}

async function loadCaptureConfig(): Promise<CaptureConfig> {
  const settings = loadSettings();
  const { apiKey, azureFormatApiKey, openaiFormatApiKey, langsmithApiKey } =
    await getAllApiKeys();
  const formatApiKey =
    settings.formatProvider === "openai" ? openaiFormatApiKey : azureFormatApiKey;
  warmupFormatConnection(settings.formatProvider, settings.formatEndpoint);
  return { settings, apiKey, formatApiKey, langsmithApiKey };
}

// 失効したデバイスIDで getUserMedia すると WebView2 で停止しうるため、事前に自己治癒する。
async function validateAudioDevice(
  settings: AppSettings,
): Promise<{ effectiveDeviceId: string; settings: AppSettings }> {
  const { audioDeviceId } = settings;
  if (!audioDeviceId) return { effectiveDeviceId: "", settings };

  const devices = await navigator.mediaDevices.enumerateDevices();
  const exists = devices.some(
    (device) => device.kind === "audioinput" && device.deviceId === audioDeviceId,
  );
  if (exists) return { effectiveDeviceId: audioDeviceId, settings };

  logWarn(
    "captureAttempt.validateAudioDevice",
    "saved audioDeviceId not found, falling back to default",
    { audioDeviceId },
  );
  const updated = { ...settings, audioDeviceId: "" };
  persistSettings(updated);
  return { effectiveDeviceId: "", settings: updated };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("録音開始はキャンセルされました", "AbortError");
  }
}

/**
 * 録音1回分のマイク・認識器・システムミュートをまとめて所有する。
 * Controller は生成直後からこのhandleを所有するため、start未完了でもdisposeできる。
 */
export class CaptureAttempt
  implements ManagedRecordingAttempt<CaptureContext>
{
  private readonly session = new TranscriptionSession();
  private readonly input: CreateRecordingAttemptInput;
  private startCalled = false;
  private muteLeasePromise: Promise<number> | null = null;
  private muteReleaseRequested = false;
  private muteAcquireCommand: Promise<void> | null = null;
  private muteAcquire: Promise<void> | null = null;
  private muteReleaseCommand: Promise<void> | null = null;
  private muteRelease: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(input: CreateRecordingAttemptInput) {
    this.input = input;
  }

  async start(signal: AbortSignal): Promise<CaptureContext> {
    if (this.startCalled) throw new Error("CaptureAttempt.start() was called twice");
    this.startCalled = true;
    const startedAt = new Date();

    try {
      const config = await loadCaptureConfig();
      throwIfAborted(signal);

      const validated = await validateAudioDevice(config.settings);
      throwIfAborted(signal);
      const settings = validated.settings;
      const effectiveDeviceId = validated.effectiveDeviceId;

      const windowPromise = settings.contextAwareFormatting
        ? invoke<CapturedWindow>("get_foreground_window")
            .then((window) => (window.id ? window : null))
            .catch((error) => {
              logWarn("captureAttempt.start", "get_foreground_window failed", { error });
              return null;
            })
        : null;

      // tokenはRust側で単調採番する。WebView再読込や時計変更に依存しない。
      this.muteLeasePromise = invoke<number>("create_system_audio_mute_lease");
      this.muteAcquireCommand = this.muteLeasePromise
        .then((leaseId) => {
          if (this.muteReleaseRequested) return;
          return invoke<void>("set_system_audio_mute", {
            leaseId,
            mute: true,
          });
        })
        .catch((error) => {
          logWarn("captureAttempt.start", "system audio mute acquire failed", {
            error,
          });
        });
      this.muteAcquire = waitForMuteIpc(
        this.muteAcquireCommand,
        "set_system_audio_mute(true)",
      );

      await Promise.all([
        this.muteAcquire,
        this.session.start(
          {
            provider: settings.transcriptionProvider,
            endpoint: settings.endpoint,
            apiKey: config.apiKey,
            model: settings.transcriptionModel,
            speechEndpoint: settings.speechEndpoint,
            speechLanguage: settings.speechLanguage,
            audioDeviceId: effectiveDeviceId,
            onInterimResult: this.input.onInterimResult,
            onRecognitionError: this.input.onRecognitionError,
          },
          signal,
        ),
      ]);
      throwIfAborted(signal);

      return {
        settings,
        formatApiKey: config.formatApiKey,
        langsmithApiKey: config.langsmithApiKey,
        startedAt,
        windowPromise,
      };
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async stop(signal?: AbortSignal): Promise<string> {
    // unmute IPCと認識停止を並行させ、補助機能の遅延で文字起こしを止めない。
    const muteRelease = this.releaseMute();
    try {
      return await this.session.stop(signal);
    } finally {
      await Promise.all([muteRelease, this.session.dispose()]);
    }
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.all([
        this.releaseMute(),
        this.session.dispose(),
      ]).then(() => undefined);
    }
    return this.disposePromise;
  }

  getAudioLevel(): number {
    return this.session.getAudioLevel();
  }

  get wasSilent(): boolean {
    return this.session.wasSilent;
  }

  private releaseMute(): Promise<void> {
    if (!this.muteLeasePromise) return Promise.resolve();
    this.muteReleaseRequested = true;
    if (!this.muteReleaseCommand) {
      // token発行後はacquire応答を待たずreleaseを送る。Rust側tombstoneにより
      // release先行でも遅延acquireは無効化される。
      this.muteReleaseCommand = this.muteLeasePromise
        .then((leaseId) => this.sendMuteRelease(leaseId))
        .catch((error) => {
          logWarn("captureAttempt.dispose", "mute lease creation failed", {
            error,
          });
        });
      this.muteRelease = waitForMuteIpc(
        this.muteReleaseCommand,
        "set_system_audio_mute(false)",
      );
    }
    return this.muteRelease!;
  }

  private async sendMuteRelease(leaseId: number): Promise<void> {
    for (let retry = 0; retry < 2; retry++) {
      try {
        await invoke<void>("set_system_audio_mute", { leaseId, mute: false });
        return;
      } catch (error) {
        logWarn("captureAttempt.dispose", "system audio mute release failed", {
          retry,
          error,
        });
      }
    }
  }
}
