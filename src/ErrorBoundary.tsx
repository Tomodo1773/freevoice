import { Component, ErrorInfo, ReactNode } from "react";
import { logError } from "./diagLog";

interface Props {
  scope: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** React のレンダリング中に投げられた例外を捕捉して診断ログに残す。
 *  境界が無いと、レンダリング例外はツリー全体をアンマウントし「真っ白な画面 + ログ無し」
 *  になる。ユーザーが最も気づきにくく訴えにくい故障なので、必ず記録する。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError(`react.${this.props.scope}`, "render error", error, {
      componentStack: info.componentStack ?? "",
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, fontFamily: "sans-serif", fontSize: 13 }}>
          画面の描画中にエラーが発生しました。詳細はログファイルに出力されています。
        </div>
      );
    }
    return this.props.children;
  }
}
