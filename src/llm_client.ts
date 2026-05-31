import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources";

// ─── Provider detection ───

type Provider = "openai" | "anthropic" | "google" | "custom" | "other";

function detectProvider(model: string): Provider {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("gpt") || lower.includes("openai")) return "openai";
  return "other";
}

// ─── API key resolution ───

function resolveApiKey(provider: Provider, baseUrl?: string): string | undefined {
  // When a custom base URL is given, try all keys in order
  if (baseUrl) return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    default:
      return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  }
}

// ─── Base URL resolution ───

function resolveBaseUrl(provider: Provider, explicitBaseUrl?: string): string | undefined {
  if (explicitBaseUrl) return explicitBaseUrl;
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "openai":
      return undefined; // OpenAI SDK default
    default:
      return undefined;
  }
}

// ─── Client ───

export interface LLMClientOptions {
  model: string;          // provider/model-name  (e.g. "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "custom/mymodel")
  baseUrl?: string;       // explicit OpenAI-compatible endpoint
  verbose?: boolean;
}

export interface LLMClient {
  client: OpenAI;
  model: string;
  provider: Provider;
}

export function createLLMClient(opts: LLMClientOptions): LLMClient {
  const [providerPrefix, modelName] = opts.model.split("/");
  const provider = detectProvider(opts.model);
  const apiKey = resolveApiKey(provider, opts.baseUrl);
  const baseUrl = resolveBaseUrl(provider, opts.baseUrl);

  if (!apiKey) {
    const hint = provider === "anthropic"
      ? "Set ANTHROPIC_API_KEY"
      : provider === "google"
        ? "Set GOOGLE_API_KEY or GEMINI_API_KEY"
        : provider === "openai"
          ? "Set OPENAI_API_KEY"
          : "Set LLM_API_KEY or use --base-url";
    throw new Error(`No API key for model ${opts.model}. ${hint}`);
  }

  const clientOpts: { apiKey: string; baseURL?: string } = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;

  return {
    client: new OpenAI(clientOpts),
    model: modelName || opts.model,
    provider,
  };
}

// ─── Call ───

export async function callLLM(
  llm: LLMClient,
  prompt: string,
  temperature: number = 0.7,
  maxTokens: number = 4096,
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];

  const resp = await llm.client.chat.completions.create({
    model: llm.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  let text = resp.choices[0]?.message?.content?.trim() || "";

  // Strip markdown code fences if present
  if (text.startsWith("```")) {
    const inner = text.split("```");
    text = inner.length >= 3 ? inner[1] : inner[2] || text;
    // Remove leading language tag like "json\n"
    if (text.match(/^(json|txt|text|md)\n/)) {
      text = text.replace(/^(json|txt|text|md)\n/, "");
    }
  }

  return text.trim();
}

// ─── JSON parsing ───

export function parseJSONResponse<T>(text: string, fallback: T): T {
  // Try direct parse first
  try { return JSON.parse(text) as T; } catch {}

  // Try to extract JSON from markdown code fences
  const fenceMatch = text.match(/```(?:json|txt|text)?\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) as T; } catch {}
  }

  // Try to find a JSON object or array in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]) as T; } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]) as T; } catch {}
  }

  return fallback;
}
