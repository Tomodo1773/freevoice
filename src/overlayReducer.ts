export type OverlayPhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "formatting"
  | "done"
  | "error"
  /** 無音で終了した終端表示。制御上は idle/done と同じく「次の録音を開始できる」状態。 */
  | "nospeech";

export interface OverlayState {
  phase: OverlayPhase;
  transcript: string;
  errorMsg: string;
  fallback: boolean;
  fallbackReason: string;
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
  | { type: "FORMAT_DONE"; fallback?: boolean; fallbackReason?: string }
  | { type: "STOP_ERROR"; errorMsg: string }
  | { type: "ABORT_CANCELLED" }
  | { type: "SET_TRANSCRIPT"; transcript: string }
  | { type: "BEGIN_FADE" }
  | { type: "FADE_DONE" };

export const initialState: OverlayState = {
  phase: "idle",
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
    case "RECORDING_START": {
      // 開始可否のガードは decideStartEdge に一本化（ハンドラの分岐と同一の唯一の定義）。
      // fading は終端 phase(done/error/nospeech)に必ず伴うため phase だけで判定できる。
      if (decideStartEdge(state.phase) !== "start") return state;
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
      // 無音は専用の終端 nospeech（メッセージ表示・1500ms）。
      // 非無音の空結果は通常の終端 done（150ms）へ畳む。いずれも制御上は「開始可能」。
      return action.silent
        ? {
            ...state,
            phase: "nospeech",
            transcript: "音声が検出されませんでした",
            hideRequest: { ms: 1500, seq: nextSeq(state) },
          }
        : {
            ...state,
            phase: "done",
            hideRequest: { ms: 150, seq: nextSeq(state) },
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

/**
 * キーエッジ（recording-start）の意味を現在の制御状態だけから決める唯一のガード。
 * ハンドラ側の ref 判定を排し、判定を1箇所（＝status）に集約する。
 */
export type StartEdge = "start" | "cancel" | "ignore";

export function decideStartEdge(phase: OverlayPhase): StartEdge {
  if (phase === "recording") return "ignore"; // 既に録音中
  if (phase === "transcribing" || phase === "formatting") return "cancel"; // 処理中の再押下＝キャンセル
  return "start"; // idle / done / error / nospeech — 次の録音を開始
}

/** キーエッジ（recording-stop）の意味。録音中のみ停止し、それ以外は無視する。 */
export function decideStopEdge(phase: OverlayPhase): "stop" | "ignore" {
  return phase === "recording" ? "stop" : "ignore";
}

/**
 * overlayReducer を包む最小ストア。制御 status を単一の真実として同期的に読める。
 * useReducer と違い dispatch 時点で getState() が即更新されるため、mount 時クロージャの
 * イベントハンドラからでも最新 status を読め（stale closure 問題の根本解消）、
 * 連続するキーエッジも同一 tick 内で正しく判定できる。
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
      if (next === state) return; // 無効遷移（reducer が同一参照を返す）は購読者に通知しない
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
