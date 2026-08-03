import { logError, logInfo } from "./diagLog";

let installed = false;

/** 未捕捉例外と unhandledrejection を「最後の砦」として診断ログに記録する。
 *
 *  個別の try/catch はあくまで想定した処理パスしか拾えない。想定していない場所で
 *  投げられた例外や、await されずに reject した Promise は、この保険が無いと
 *  どこにも記録されずに消える。「不具合が起きたがログが無い」を無くすための土台。
 *
 *  各ウィンドウ（main / overlay）のエントリポイントで、他の初期化より先に呼ぶ。 */
export function installGlobalErrorLogging(scope: string): void {
  if (installed) return;
  installed = true;

  // React のレンダリング例外を含む未捕捉エラー。reportError 経由でここに届く。
  // リソース読み込み失敗（event.error が無い）も message/filename で記録する。
  window.addEventListener("error", (event) => {
    logError(`global.${scope}`, "uncaught error", event.error ?? event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  // await されずに reject した Promise。非同期処理の握り漏れを確実に捕捉する。
  window.addEventListener("unhandledrejection", (event) => {
    logError(`global.${scope}`, "unhandled promise rejection", event.reason);
  });

  // CSP に阻まれた読み込み・実行。ブロックは例外にならないため error にも
  // unhandledrejection にも現れず、この保険が無いとどこにも記録されない。
  // ライブラリが違反を握り潰して別経路へフォールバックする場合、記録が無いと
  // 「なぜか挙動が違う」という結果だけが残り、原因を追えない。
  document.addEventListener("securitypolicyviolation", (event) => {
    logError(`global.${scope}`, "CSP violation blocked a resource", event.violatedDirective, {
      blockedURI: event.blockedURI,
      disposition: event.disposition,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
    });
  });

  // 保険が有効になったことをマーカーとして残す（以降の記録の起点になる）。
  logInfo(`global.${scope}`, "global error handlers installed");
}
