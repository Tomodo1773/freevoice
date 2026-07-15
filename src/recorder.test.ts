import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RecorderController,
  type RecorderDeps,
  type RecorderView,
  type RecordingConfig,
  type SessionCallbacks,
  type ActiveSession,
} from "./recorder";
import { DEFAULT_SETTINGS } from "./types";

// diagLog は invoke(@tauri-apps/api/core) を叩くため、node 環境では no-op に差し替える。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マクロタスク境界まで待って、連鎖した await を進める。 */
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await flush();
}

function makeView() {
  const calls: string[] = [];
  const view: RecorderView = {
    recording: () => void calls.push("recording"),
    transcript: (t) => void calls.push(`transcript:${t}`),
    transcribing: () => void calls.push("transcribing"),
    formatting: () => void calls.push("formatting"),
    done: (fb, r) => void calls.push(`done:${fb}:${r}`),
    empty: (s) => void calls.push(`empty:${s}`),
    error: (m) => void calls.push(`error:${m}`),
    cancelled: () => void calls.push("cancelled"),
  };
  return { view, calls };
}

interface Harness {
  controller: RecorderController;
  deps: RecorderDeps;
  calls: string[];
  muteCalls: boolean[];
  pasteCalls: string[];
  savedLogs: Record<string, unknown>[];
  refreshCalls: { formatted: string }[];
  micTrackStop: ReturnType<typeof vi.fn>;
  session: ActiveSession & { stop: ReturnType<typeof vi.fn> };
  getCallbacks: () => SessionCallbacks | undefined;
}

function harness(overrides: Partial<RecorderDeps> = {}, settingsOverride = {}): Harness {
  const { view, calls } = makeView();
  const muteCalls: boolean[] = [];
  const pasteCalls: string[] = [];
  const savedLogs: Record<string, unknown>[] = [];
  const refreshCalls: { formatted: string }[] = [];
  const micTrackStop = vi.fn();
  const mic = { getTracks: () => [{ stop: micTrackStop }] } as unknown as MediaStream;
  const session = {
    stop: vi.fn(async () => "こんにちは"),
    getAudioLevel: () => 0,
    wasSilent: false,
  } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
  let capturedCallbacks: SessionCallbacks | undefined;

  const config: RecordingConfig = {
    settings: { ...DEFAULT_SETTINGS, contextAwareFormatting: false, ...settingsOverride },
    apiKey: "key",
    formatApiKey: "fkey",
    langsmithApiKey: "",
    effectiveDeviceId: "",
  };

  const deps: RecorderDeps = {
    view,
    now: () => new Date(0),
    startTimeoutMs: 10000,
    beep: () => {},
    loadConfig: async () => config,
    resolveWindow: async () => null,
    acquireMic: async () => mic,
    startTranscription: async (_mic, _config, cb) => {
      capturedCallbacks = cb;
      return session;
    },
    setMute: async (m) => void muteCalls.push(m),
    getContext: () => null,
    format: async (raw) => ({ text: `${raw}(整形)`, fallback: false, fallbackReason: "" }),
    paste: async (t) => void pasteCalls.push(t),
    saveLog: async (_c, _n, d) => void savedLogs.push(d as unknown as Record<string, unknown>),
    refreshTopic: (_w, formatted) => void refreshCalls.push({ formatted }),
    ...overrides,
  };

  return {
    controller: new RecorderController(deps),
    deps,
    calls,
    muteCalls,
    pasteCalls,
    savedLogs,
    refreshCalls,
    micTrackStop,
    session,
    getCallbacks: () => capturedCallbacks,
  };
}

describe("RecorderController / RecordingJob", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("正常フロー", () => {
    it("keyDown→keyUp で 文字起こし→整形→貼り付け→done まで進む", async () => {
      const h = harness();
      h.controller.keyDown();
      await settle();
      expect(h.calls).toContain("recording");
      expect(h.controller.isRecording).toBe(true);

      h.controller.keyUp();
      await settle();

      expect(h.calls).toEqual([
        "recording",
        "transcribing",
        "transcript:こんにちは",
        "formatting",
        "done:false:",
      ]);
      expect(h.pasteCalls).toEqual(["こんにちは(整形)"]);
      expect(h.muteCalls).toEqual([true, false]);
      expect(h.micTrackStop).toHaveBeenCalled();
    });

    it("完了後はジョブが解放され、次の keyDown で新しい録音が始まる", async () => {
      const loadConfig = vi.fn(async () => harness().deps.loadConfig());
      const h = harness({ loadConfig });
      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();
      expect(h.controller.isRecording).toBe(false);

      h.controller.keyDown();
      await settle();
      expect(h.controller.isRecording).toBe(true);
      expect(loadConfig).toHaveBeenCalledTimes(2);
    });
  });

  describe("単一ジョブ不変条件", () => {
    it("録音中の再 keyDown は無視され、二重ジョブを作らない", async () => {
      const loadConfig = vi.fn(harness().deps.loadConfig);
      const h = harness({ loadConfig });
      h.controller.keyDown();
      await settle();
      h.controller.keyDown(); // 録音中の再押下
      h.controller.keyDown();
      await settle();
      expect(loadConfig).toHaveBeenCalledTimes(1);
    });

    it("開始処理中（session 確立前）の再 keyDown も無視される", async () => {
      const micGate = deferred<MediaStream>();
      const acquireMic = vi.fn(() => micGate.promise);
      const loadConfig = vi.fn(harness().deps.loadConfig);
      const h = harness({ acquireMic, loadConfig });
      h.controller.keyDown();
      await settle();
      // まだ mic 取得中（starting）。ここでの再押下は無視。
      h.controller.keyDown();
      await settle();
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(acquireMic).toHaveBeenCalledTimes(1);
    });
  });

  describe("開始処理中の keyUp（旧 stop-pending の置換）", () => {
    it("session 確立前に離しても、確立後にそのまま処理へ進む", async () => {
      const startGate = deferred<ActiveSession>();
      const session = {
        stop: vi.fn(async () => "やあ"),
        getAudioLevel: () => 0,
        wasSilent: false,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const startTranscription = vi.fn(() => startGate.promise);
      const h = harness({ startTranscription });

      h.controller.keyDown();
      await settle();
      // まだ session 確立前にキーを離す
      h.controller.keyUp();
      await settle();
      // ここで session 確立 → 即 stop して処理へ
      startGate.resolve(session);
      await settle();

      expect(h.pasteCalls).toEqual(["やあ(整形)"]);
      expect(h.muteCalls).toEqual([true, false]);
    });
  });

  describe("認識エラー", () => {
    it("録音中の認識エラーで error 表示とリソース解放を行い、処理は走らない", async () => {
      const h = harness();
      h.controller.keyDown();
      await settle();
      // 認識エラーコールバックを発火
      h.getCallbacks()!.onError("音声認識が切断されました");
      await settle();

      expect(h.calls).toContain("error:音声認識が切断されました");
      expect(h.pasteCalls).toEqual([]);
      expect(h.muteCalls).toEqual([true, false]); // ミュートは確実に解除
      expect(h.micTrackStop).toHaveBeenCalled(); // マイクは確実に解放
      expect(h.session.stop).toHaveBeenCalled(); // セッションも解放
    });
  });

  describe("処理中のキャンセル", () => {
    it("整形中の再 keyDown で AbortError → cancelled 表示、貼り付けない", async () => {
      const formatGate = deferred<{ text: string; fallback: boolean; fallbackReason: string }>();
      const format = vi.fn((_raw: string, _c: RecordingConfig, _ctx: string | null, signal: AbortSignal) => {
        signal.addEventListener("abort", () => {
          formatGate.reject(new DOMException("aborted", "AbortError"));
        });
        return formatGate.promise;
      });
      const h = harness({ format });

      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();
      // ここで formatting 中。再押下でキャンセル。
      expect(h.calls).toContain("formatting");
      h.controller.keyDown();
      await settle();

      expect(h.calls).toContain("cancelled");
      expect(h.pasteCalls).toEqual([]);
    });
  });

  describe("空結果", () => {
    it("文字起こしが空なら empty 表示（silent フラグを伝える）", async () => {
      const session = {
        stop: vi.fn(async () => ""),
        getAudioLevel: () => 0,
        wasSilent: true,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const h = harness({ startTranscription: async () => session });
      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();

      expect(h.calls).toContain("empty:true");
      expect(h.pasteCalls).toEqual([]);
      expect(h.muteCalls).toEqual([true, false]);
    });
  });

  describe("開始失敗", () => {
    it("マイク取得失敗で error 表示・ログ保存し、ミュートは掛けない", async () => {
      const acquireMic = vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      });
      const h = harness({ acquireMic });
      h.controller.keyDown();
      await settle();

      expect(h.calls).toContain("error:マイクの使用が許可されていません");
      expect(h.muteCalls).toEqual([]); // セッション開始前なのでミュートしていない
      expect(h.savedLogs.length).toBe(1);
      expect(h.controller.isRecording).toBe(false);
    });

    it("セッション開始失敗でも error 表示し、ミュートは確実に解除される", async () => {
      const startTranscription = vi.fn(async () => {
        throw new Error("endpoint が未設定です");
      });
      const h = harness({ startTranscription });
      h.controller.keyDown();
      await settle();

      expect(h.calls).toContain("error:endpoint が未設定です");
      expect(h.muteCalls).toEqual([true, false]);
      expect(h.micTrackStop).toHaveBeenCalled();
    });
  });

  describe("開始タイムアウト（旧 START_STALL の置換）", () => {
    it("マイク取得が停滞したら startTimeoutMs 経過で error にする", async () => {
      const micGate = deferred<MediaStream>(); // 永遠に解決しない
      const acquireMic = vi.fn(() => micGate.promise);
      const h = harness({ acquireMic, startTimeoutMs: 20 });
      h.controller.keyDown();
      await new Promise((r) => setTimeout(r, 40));
      await settle();

      expect(h.calls.some((c) => c.startsWith("error:"))).toBe(true);
      expect(h.controller.isRecording).toBe(false);
    });
  });

  describe("コンテキスト連動", () => {
    it("contextAwareFormatting=true でウィンドウ取得時、refreshTopic とログ保存に反映される", async () => {
      const h = harness(
        {
          resolveWindow: async () => ({ id: "w1", exe: "code.exe", title: "editor" }),
          getContext: () => "前回の話題",
        },
        { contextAwareFormatting: true }
      );
      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();

      expect(h.refreshCalls.length).toBe(1);
      expect(h.savedLogs[0]).toMatchObject({
        window: { exe: "code.exe", title: "editor" },
        topic: "前回の話題",
      });
    });
  });
});
