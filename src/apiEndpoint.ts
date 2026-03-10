import { ApiProvider } from "./types";

const OPENAI_BASE = "https://api.openai.com/v1";

function resolveAzureBase(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(
      "endpoint は https://{resource}.openai.azure.com 形式で設定してください"
    );
  }
  const host = url.hostname.toLowerCase();

  // https://xxx.services.ai.azure.com/... → https://xxx.openai.azure.com
  if (host.endsWith(".services.ai.azure.com")) {
    const resource = url.hostname.split(".")[0];
    return `https://${resource}.openai.azure.com/openai/v1`;
  }

  // https://xxx.openai.azure.com → そのまま /openai/v1 を付与
  if (host.endsWith(".openai.azure.com")) {
    return `${url.protocol}//${url.hostname}/openai/v1`;
  }

  // その他（カスタムエンドポイント）: 末尾スラッシュを除去してそのまま
  return url.href.replace(/\/+$/, "");
}

function getBaseUrl(provider: ApiProvider, endpoint: string): string {
  return provider === "openai" ? OPENAI_BASE : resolveAzureBase(endpoint);
}

export function buildTranscriptionUrl(provider: ApiProvider, endpoint: string): string {
  return `${getBaseUrl(provider, endpoint)}/audio/transcriptions`;
}

export function buildChatCompletionsUrl(provider: ApiProvider, endpoint: string): string {
  return `${getBaseUrl(provider, endpoint)}/chat/completions`;
}

export function buildAuthHeaders(provider: ApiProvider, apiKey: string): Record<string, string> {
  return provider === "openai"
    ? { Authorization: `Bearer ${apiKey}` }
    : { "api-key": apiKey };
}
