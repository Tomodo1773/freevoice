import OpenAI from "openai";
import { FormatProvider } from "./types";

export function resolveBaseURL(
  provider: FormatProvider,
  endpoint: string,
): string {
  if (provider === "openai") return "https://api.openai.com/v1";
  return `${endpoint.replace(/\/+$/, "")}/openai/v1`;
}

export function createChatClient(
  provider: FormatProvider,
  endpoint: string,
  apiKey: string,
): OpenAI {
  return new OpenAI({
    baseURL: resolveBaseURL(provider, endpoint),
    apiKey,
    dangerouslyAllowBrowser: true,
  });
}
