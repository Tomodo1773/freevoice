import { invoke } from "@tauri-apps/api/core";
import { formatError } from "./errors";

/** 診断ログのレベル。INFO=情報, WARN=警告, ERROR=異常 */
type Level = "INFO" | "WARN" | "ERROR";

/** Rust 側の append_diag_log コマンドに 1 行追記する。
 *  診断ログ自体が失敗しても本流を止めないため、fire-and-forget で使う。 */
function write(
  level: Level,
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  invoke("append_diag_log", {
    level,
    source,
    message,
    context: context ? JSON.stringify(context) : null,
  }).catch((e) => {
    // 診断ログ自体が失敗した場合は console に fallback（最後の手段）
    // eslint-disable-next-line no-console
    console.error("[diagLog] append failed", e, { level, source, message });
  });
}

/** 正常動作のマイルストーン（起動、録音開始/終了、設定変更など） */
export function logInfo(
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  write("INFO", source, message, context);
}

/** 復旧可能な異常・想定外だが致命的でない状況（フォールバック発動、リトライなど） */
export function logWarn(
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  write("WARN", source, message, context);
}

/** 明確なエラー（API 失敗、権限エラー、クラッシュ直前など） */
export function logError(
  source: string,
  message: string,
  err: unknown,
  context?: Record<string, unknown>
): void {
  write("ERROR", source, message, { ...context, error: formatError(err) });
}
