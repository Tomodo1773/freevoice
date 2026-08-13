import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RecorderController,
  type RecorderDeps,
  type RecorderView,
  type RecordingConfig,
  type SessionCallbacks,
  type ActiveSession,
  type FormatOutcome,
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
    starting: () => void calls.push("starting"),
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
  getBeepCalls: () => number;
  muteCalls: boolean[];
  cancelableCalls: boolean[];
  pasteCalls: string[];
  savedLogs: Record<string, unknown>[];
  refreshCalls: { formatted: string }[];
  micTrackStop: ReturnType<typeof vi.fn>;
  session: ActiveSession & { stop: ReturnType<typeof vi.fn> };
  getCallbacks: () => SessionCallbacks | undefined;
}

function harness(overrides: Partial<RecorderDeps> = {}, settingsOverride = {}): Harness {
  const { view, calls } = makeView();
  let beepCalls = 0;
  const muteCalls: boolean[] = [];
  const cancelableCalls: boolean[] = [];
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
    beep: () => {
      beepCalls++;
    },
    loadConfig: async () => config,
    resolveWindow: async () => null,
    acquireMic: async () => mic,
    createSession: (_mic, _config, cb) => {
      capturedCallbacks = cb;
      return { session, ready: Promise.resolve() };
    },
    setMute: async (m) => void muteCalls.push(m),
    setCancelable: (c) => void cancelableCalls.push(c),
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
    getBeepCalls: () => beepCalls,
    muteCalls,
    cancelableCalls,
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
      expect(h.getBeepCalls()).toBe(1);
      expect(h.controller.isRecording).toBe(true);

      h.controller.keyUp();
      await settle();

      expect(h.calls).toEqual([
        "starting",
        "recording",
        "transcribing",
        "transcript:こんにちは",
        "formatting",
        "done:false:",
      ]);
      expect(h.pasteCalls).toEqual(["こんにちは(整形)"]);
      expect(h.muteCalls).toEqual([true, false]);
      expect(h.getBeepCalls()).toBe(1);
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
      const startGate = deferred<void>();
      const session = {
        stop: vi.fn(async () => "やあ"),
        getAudioLevel: () => 0,
        wasSilent: false,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const createSession = vi.fn(() => ({ session, ready: startGate.promise }));
      const h = harness({ createSession });

      h.controller.keyDown();
      await settle();
      // まだ session 確立前にキーを離す
      h.controller.keyUp();
      await settle();
      // ここで session 確立 → 即 stop して処理へ
      startGate.resolve();
      await settle();

      expect(h.pasteCalls).toEqual(["やあ(整形)"]);
      expect(h.muteCalls).toEqual([true, false]);
      expect(h.getBeepCalls()).toBe(1);
      expect(h.calls).toEqual([
        "starting",
        "transcribing",
        "transcript:やあ",
        "formatting",
        "done:false:",
      ]);
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

  describe("キャンセル（Esc）", () => {
    /** 整形を宙吊りにして、処理中（formatting）で止まったジョブを作る。 */
    async function stalledInFormatting() {
      const formatGate = deferred<FormatOutcome>();
      const format = vi.fn(
        (_raw: string, _c: RecordingConfig, _ctx: string | null, signal: AbortSignal) => {
          signal.addEventListener("abort", () => {
            formatGate.reject(new DOMException("aborted", "AbortError"));
          });
          return formatGate.promise;
        }
      );
      const loadConfig = vi.fn(harness().deps.loadConfig);
      const h = harness({ format, loadConfig });

      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();
      expect(h.calls).toContain("formatting");
      return { h, loadConfig, formatGate };
    }

    it("整形中の Esc で AbortError → cancelled 表示、貼り付けない", async () => {
      const { h } = await stalledInFormatting();

      h.controller.cancel();
      await settle();

      expect(h.calls).toContain("cancelled");
      expect(h.pasteCalls).toEqual([]);
    });

    it("整形処理を待っている間は既にマイクを解放している", async () => {
      const { h, formatGate } = await stalledInFormatting();

      expect(h.micTrackStop).toHaveBeenCalledTimes(1);

      formatGate.resolve({ text: "こんにちは(整形)", fallback: false, fallbackReason: "" });
      await settle();
      expect(h.micTrackStop).toHaveBeenCalledTimes(1);
    });

    it("処理中の keyDown はキャンセルも新規録音もしない", async () => {
      const { h, loadConfig, formatGate } = await stalledInFormatting();

      h.controller.keyDown();
      await settle();

      expect(h.calls).not.toContain("cancelled");
      expect(loadConfig).toHaveBeenCalledTimes(1);

      // 中断されていないので、整形が返れば通常どおり完了する
      formatGate.resolve({ text: "こんにちは(整形)", fallback: false, fallbackReason: "" });
      await settle();
      expect(h.pasteCalls).toEqual(["こんにちは(整形)"]);
    });

    it("録音中の Esc は無視され、そのまま録音を続けて完了できる", async () => {
      const h = harness();
      h.controller.keyDown();
      await settle();

      h.controller.cancel();
      await settle();
      expect(h.controller.isRecording).toBe(true);
      expect(h.calls).not.toContain("cancelled");

      h.controller.keyUp();
      await settle();
      expect(h.pasteCalls).toEqual(["こんにちは(整形)"]);
    });

    it("ジョブが無いときの Esc は無視される", async () => {
      const h = harness();
      h.controller.cancel();
      await settle();
      expect(h.calls).toEqual([]);
    });
  });

  describe("キャンセル可能区間の同期", () => {
    it("処理に入るまでは開かれず、終端で必ず閉じられる", async () => {
      const h = harness();
      h.controller.keyDown();
      await settle();
      expect(h.cancelableCalls).toEqual([]); // 録音中はまだ Esc を奪わない

      h.controller.keyUp();
      await settle();
      expect(h.cancelableCalls).toEqual([true, false]);
    });

    it("開始に失敗して処理に入らなかったジョブでも閉じられる", async () => {
      const acquireMic = vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      });
      const h = harness({ acquireMic });
      h.controller.keyDown();
      await settle();

      expect(h.cancelableCalls).toEqual([false]);
    });
  });

  describe("空結果", () => {
    it("文字起こしが空なら empty 表示（silent フラグを伝える）", async () => {
      const session = {
        stop: vi.fn(async () => ""),
        getAudioLevel: () => 0,
        wasSilent: true,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const h = harness({ createSession: () => ({ session, ready: Promise.resolve() }) });
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
      const failedSession = {
        stop: vi.fn(async () => ""),
        getAudioLevel: () => 0,
        wasSilent: false,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const createSession = vi.fn(() => ({
        session: failedSession,
        ready: Promise.reject(new Error("endpoint が未設定です")),
      }));
      const h = harness({ createSession });
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

    it("タイムアウト後にマイク取得が遅れて成功してもストリームを解放する", async () => {
      const micGate = deferred<MediaStream>();
      const lateTrackStop = vi.fn();
      const lateMic = {
        getTracks: () => [{ stop: lateTrackStop }],
      } as unknown as MediaStream;
      const h = harness({ acquireMic: () => micGate.promise, startTimeoutMs: 20 });

      h.controller.keyDown();
      await new Promise((r) => setTimeout(r, 40));
      await settle();

      micGate.resolve(lateMic);
      await settle();
      expect(lateTrackStop).toHaveBeenCalledTimes(1);
    });

    it("設定読込を含む開始処理全体が startTimeoutMs で打ち切られる", async () => {
      const configGate = deferred<RecordingConfig>();
      const h = harness({ loadConfig: () => configGate.promise, startTimeoutMs: 20 });

      h.controller.keyDown();
      await new Promise((r) => setTimeout(r, 40));
      await settle();

      expect(h.calls.some((c) => c.startsWith("error:"))).toBe(true);
      expect(h.controller.isRecording).toBe(false);
    });

    it("セッション開始がタイムアウトしても await 前から所有して停止する", async () => {
      const readyGate = deferred<void>();
      let callbacks: SessionCallbacks | undefined;
      const pendingSession = {
        stop: vi.fn(async () => ""),
        getAudioLevel: () => 0,
        wasSilent: false,
      } as ActiveSession & { stop: ReturnType<typeof vi.fn> };
      const h = harness({
        createSession: (_mic, _config, cb) => {
          callbacks = cb;
          return { session: pendingSession, ready: readyGate.promise };
        },
        startTimeoutMs: 20,
      });

      h.controller.keyDown();
      await new Promise((r) => setTimeout(r, 40));
      await settle();

      expect(pendingSession.stop).toHaveBeenCalledTimes(1);
      expect(h.calls.some((c) => c.startsWith("error:"))).toBe(true);
      callbacks!.onInterim("遅延した古い文字起こし");
      expect(h.calls).not.toContain("transcript:遅延した古い文字起こし");
      readyGate.resolve();
    });
  });

  describe("終端と次の録音", () => {
    it("ログ保存中でも done 表示後の keyDown で次の録音を開始できる", async () => {
      const logGate = deferred<void>();
      const loadConfig = vi.fn(harness().deps.loadConfig);
      const h = harness({
        loadConfig,
        saveLog: () => logGate.promise,
      });

      h.controller.keyDown();
      await settle();
      h.controller.keyUp();
      await settle();
      expect(h.calls).toContain("done:false:");

      h.controller.keyDown();
      await settle();
      expect(loadConfig).toHaveBeenCalledTimes(2);

      logGate.resolve();
      h.controller.keyUp();
      await settle();
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
