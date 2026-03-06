function normalizeEndpoint(endpoint: string): URL {
  try {
    return new URL(endpoint.trim());
  } catch {
    throw new Error(
      "endpoint は https://{resource}.services.ai.azure.com または https://{resource}.openai.azure.com 形式で設定してください"
    );
  }
}

export function resolveAzureOpenAIBase(endpoint: string): string {
  const url = normalizeEndpoint(endpoint);
  const host = url.hostname.toLowerCase();

  if (host.endsWith(".openai.azure.com")) {
    return `${url.protocol}//${url.hostname}`;
  }

  if (host.endsWith(".services.ai.azure.com")) {
    const resource = url.hostname.split(".")[0];
    return `${url.protocol}//${resource}.openai.azure.com`;
  }

  return `${url.protocol}//${url.host}`;
}

export function buildAzureTranscriptionUrl(endpoint: string, deployment: string): string {
  const base = resolveAzureOpenAIBase(endpoint);
  const deploymentId = encodeURIComponent(deployment.trim());
  return `${base}/openai/deployments/${deploymentId}/audio/transcriptions?api-version=2024-10-21`;
}

export function buildAzureChatCompletionsUrl(endpoint: string, deployment: string): string {
  const base = resolveAzureOpenAIBase(endpoint);
  const deploymentId = encodeURIComponent(deployment.trim());
  return `${base}/openai/deployments/${deploymentId}/chat/completions?api-version=2024-10-21`;
}
