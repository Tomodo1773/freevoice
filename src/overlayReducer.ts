import type { RecordingMode } from "./recordingController";

export type OverlayPhase =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "formatting"
  | "done"
  | "error"
  /** 無音で終了した終端表示。制御上は次の録音を開始できる。 */
  | "nospeech";

export interface OverlayState {
  phase: OverlayPhase;
  captureAttemptId: number | null;
  captureMode: RecordingMode | null;
  stopRequested: boolean;
  transcript: string;
  errorMsg: string;
  fallback: boolean;
  fallbackReason: string;
  fading: boolean;
  /** 非表示予約。seq で世代管理し、useEffectのcleanupでタイマーを取り消す。 */
  hideRequest: { ms: number; seq: number } | null;
}

export type OverlayAction =
  | {
      type: "CAPTURE_STATE";
      status: "starting" | "recording" | "stopping";
      attemptId: number;
      mode: RecordingMode;
      stopRequested: boolean;
      interim: string;
    }
  | { type: "CAPTURE_FAILED"; errorMsg: string }
  | { type: "CAPTURE_CANCELLED" }
  | { type: "TRANSCRIPT_EMPTY"; silent: boolean }
  | { type: "TRANSCRIPT_READY"; transcript: string }
  | { type: "FORMAT_DONE"; fallback?: boolean; fallbackReason?: string }
  | { type: "POSTPROCESS_ERROR"; errorMsg: string }
  | { type: "POSTPROCESS_CANCELLED" }
  | { type: "BEGIN_FADE" }
  | { type: "FADE_DONE" };

export const initialState: OverlayState = {
  phase: "idle",
  captureAttemptId: null,
  captureMode: null,
  stopRequested: false,
  transcript: "",
  errorMsg: "",
  fallback: false,
  fallbackReason: "",
  fading: false,
  hideRequest: null,
};

function nextSeq(state: OverlayState): number {
  return (state.hideRequest?.seq ?? 0) + 1;
}

export function overlayReducer(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case "CAPTURE_STATE": {
      if (action.status === "starting") {
        const base = state.captureAttemptId === action.attemptId ? state : initialState;
        return {
          ...base,
          phase: "starting",
          captureAttemptId: action.attemptId,
          captureMode: action.mode,
          stopRequested: action.stopRequested,
          transcript: action.interim,
          fading: false,
          hideRequest: null,
        };
      }

      if (state.captureAttemptId !== action.attemptId) return state;
      if (action.status === "recording") {
        return {
          ...state,
          phase: "recording",
          captureMode: action.mode,
          stopRequested: action.stopRequested,
          transcript: action.interim,
        };
      }

      return {
        ...state,
        phase: "transcribing",
        captureAttemptId: null,
        captureMode: null,
        stopRequested: false,
        transcript: action.interim,
      };
    }

    case "CAPTURE_FAILED":
      return {
        ...state,
        phase: "error",
        captureAttemptId: null,
        captureMode: null,
        stopRequested: false,
        errorMsg: action.errorMsg,
        hideRequest: { ms: 5000, seq: nextSeq(state) },
      };

    case "CAPTURE_CANCELLED":
      return { ...initialState };

    case "TRANSCRIPT_EMPTY":
      if (state.phase !== "transcribing") return state;
      return {
        ...state,
        phase: "nospeech",
        transcript: "音声が検出されませんでした",
        hideRequest: { ms: action.silent ? 1500 : 150, seq: nextSeq(state) },
      };

    case "TRANSCRIPT_READY":
      if (state.phase !== "transcribing") return state;
      return { ...state, phase: "formatting", transcript: action.transcript };

    case "FORMAT_DONE": {
      if (state.phase !== "formatting") return state;
      const fallback = action.fallback ?? false;
      return {
        ...state,
        phase: "done",
        fallback,
        fallbackReason: action.fallbackReason ?? "",
        hideRequest: { ms: fallback ? 3000 : 1000, seq: nextSeq(state) },
      };
    }

    case "POSTPROCESS_ERROR":
      if (state.phase !== "transcribing" && state.phase !== "formatting") return state;
      return {
        ...state,
        phase: "error",
        errorMsg: action.errorMsg,
        hideRequest: { ms: 5000, seq: nextSeq(state) },
      };

    case "POSTPROCESS_CANCELLED":
      if (state.phase !== "transcribing" && state.phase !== "formatting") return state;
      return { ...initialState };

    case "BEGIN_FADE":
      if (!state.hideRequest) return state;
      return { ...state, fading: true, hideRequest: null };

    case "FADE_DONE":
      if (!state.fading) return state;
      return { ...initialState };

    default:
      return state;
  }
}

/**
 * Overlayは表示専用ストア。録音可否や資源所有の判断はRecordingControllerだけが行う。
 */
export interface OverlayStore {
  getState: () => OverlayState;
  dispatch: (action: OverlayAction) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createOverlayStore(): OverlayStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = overlayReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
