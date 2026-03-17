export type OverlayPhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "formatting"
  | "done"
  | "error";

export interface OverlayState {
  phase: OverlayPhase;
  transcript: string;
  errorMsg: string;
  fading: boolean;
  /** 非表示予約。seq で世代管理し、useEffect のクリーンアップでタイマーを自動キャンセル */
  hideRequest: { ms: number; seq: number } | null;
}

export type OverlayAction =
  | { type: "RECORDING_START" }
  | { type: "RECORDING_FAILED"; errorMsg: string }
  | { type: "STOP_TRANSCRIBING" }
  | { type: "TRANSCRIPT_EMPTY"; silent: boolean }
  | { type: "TRANSCRIPT_READY"; transcript: string }
  | { type: "FORMAT_DONE" }
  | { type: "STOP_ERROR"; errorMsg: string }
  | { type: "ABORT_CANCELLED" }
  | { type: "SET_TRANSCRIPT"; transcript: string }
  | { type: "BEGIN_FADE" }
  | { type: "FADE_DONE" };

export const initialState: OverlayState = {
  phase: "idle",
  transcript: "",
  errorMsg: "",
  fading: false,
  hideRequest: null,
};

function nextSeq(state: OverlayState): number {
  return (state.hideRequest?.seq ?? 0) + 1;
}

export function overlayReducer(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case "RECORDING_START": {
      const canStart = state.phase === "idle" || state.fading
        || state.phase === "done" || state.phase === "error";
      if (!canStart) return state;
      return { ...initialState, phase: "recording" };
    }

    case "SET_TRANSCRIPT":
      if (state.phase !== "recording") return state;
      return { ...state, transcript: action.transcript };

    case "RECORDING_FAILED":
      if (state.phase !== "recording") return state;
      return {
        ...state,
        phase: "error",
        errorMsg: action.errorMsg,
        hideRequest: { ms: 5000, seq: nextSeq(state) },
      };

    case "STOP_TRANSCRIBING":
      if (state.phase !== "recording") return state;
      return { ...state, phase: "transcribing" };

    case "TRANSCRIPT_EMPTY":
      if (state.phase !== "transcribing") return state;
      return {
        ...state,
        phase: action.silent ? "recording" : state.phase,
        transcript: action.silent ? "音声が検出されませんでした" : state.transcript,
        hideRequest: { ms: action.silent ? 1500 : 150, seq: nextSeq(state) },
      };

    case "TRANSCRIPT_READY":
      if (state.phase !== "transcribing") return state;
      return { ...state, phase: "formatting", transcript: action.transcript };

    case "FORMAT_DONE":
      if (state.phase !== "formatting") return state;
      return {
        ...state,
        phase: "done",
        hideRequest: { ms: 1000, seq: nextSeq(state) },
      };

    case "STOP_ERROR":
      if (state.phase !== "transcribing" && state.phase !== "formatting") return state;
      return {
        ...state,
        phase: "error",
        errorMsg: action.errorMsg,
        hideRequest: { ms: 5000, seq: nextSeq(state) },
      };

    case "ABORT_CANCELLED":
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
