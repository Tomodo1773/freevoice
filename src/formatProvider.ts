export type FormatProvider = "azure" | "openai" | "gemini";

export interface FormatProviderSpec {
  /** 設定画面のプルダウンに表示する名前 */
  label: string;
  /** API のベース URL。null はユーザーがエンドポイントを入力するプロバイダー */
  baseUrl: string | null;
  /** bearer は Authorization ヘッダー、api-key は api-key ヘッダー */
  auth: "bearer" | "api-key";
  /** そのプロバイダーを初めて選んだときに入るモデル */
  defaultModel: string;
  apiKeyPlaceholder: string;
  /** LangSmith へ送る gen_ai.system の値 */
  langsmithSystem: string;
  /** Reasoning Effort に関する注意書き。なければ表示しない */
  reasoningNote?: string;
}

export const FORMAT_PROVIDERS: Record<FormatProvider, FormatProviderSpec> = {
  azure: {
    label: "Azure",
    baseUrl: null,
    auth: "api-key",
    defaultModel: "gpt-5.6-terra",
    apiKeyPlaceholder: "APIキーを入力",
    langsmithSystem: "azure.openai",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    defaultModel: "gpt-5.6-terra",
    apiKeyPlaceholder: "sk-...",
    langsmithSystem: "openai",
  },
  gemini: {
    label: "Gemini",
    // Google AI Studio の OpenAI 互換エンドポイント
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "bearer",
    defaultModel: "gemini-3.8-flash",
    apiKeyPlaceholder: "AIza...",
    langsmithSystem: "gcp.gemini",
    reasoningNote: "Gemini 3 系のモデルは none に対応していません（最小でも minimal 相当の推論が入ります）。",
  },
};

/** プルダウンの並び順を兼ねる。テーブルの定義順がそのまま表示順になる。 */
export const FORMAT_PROVIDER_ORDER = Object.keys(FORMAT_PROVIDERS) as FormatProvider[];

/** 全プロバイダー分のレコードを作る。プロバイダーごとの値を手で列挙する箇所をなくし、
 *  テーブルへの追加だけで済むようにする。 */
export function mapFormatProviders<T>(
  fn: (spec: FormatProviderSpec, provider: FormatProvider) => T,
): Record<FormatProvider, T> {
  return Object.fromEntries(
    FORMAT_PROVIDER_ORDER.map((provider) => [provider, fn(FORMAT_PROVIDERS[provider], provider)]),
  ) as Record<FormatProvider, T>;
}

export const DEFAULT_FORMAT_MODELS = mapFormatProviders((spec) => spec.defaultModel);

/** ベース URL を確定する。固定 URL を持たない Azure だけユーザー入力から組み立てる。 */
export function resolveFormatBaseUrl(provider: FormatProvider, endpoint: string): string {
  const { baseUrl } = FORMAT_PROVIDERS[provider];
  return baseUrl ?? `${endpoint.replace(/\/+$/, "")}/openai/v1`;
}

/** エンドポイントをユーザーが入力する必要があるか。 */
export function needsEndpointInput(provider: FormatProvider): boolean {
  return FORMAT_PROVIDERS[provider].baseUrl === null;
}
