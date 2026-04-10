/** 例外オブジェクトを人間可読な文字列に整形する。
 *  Error, string, その他すべての型を一貫して扱うための共通ヘルパ。 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
