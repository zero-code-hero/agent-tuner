import { OpenAI } from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
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
  model: string;
  provider: Provider;
  openaiClient?: OpenAI;
  anthropicClient?: Anthropic;
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

  // Anthropic: use the native Anthropic SDK
  if (provider === "anthropic") {
    return {
      provider,
      model: modelName || opts.model,
      anthropicClient: new Anthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      }),
    };
  }

  // OpenAI / Google / custom: use the OpenAI-compatible SDK
  const clientOpts: { apiKey: string; baseURL?: string } = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;

  return {
    provider,
    model: modelName || opts.model,
    openaiClient: new OpenAI(clientOpts),
  };
}

// ─── Call ───

export async function callLLM(
  llm: LLMClient,
  prompt: string,
  temperature: number = 0.7,
  maxTokens: number = 4096,
): Promise<string> {
  // Anthropic: native SDK call
  if (llm.anthropicClient) {
    const resp = await llm.anthropicClient.messages.create({
      model: llm.model,
      max_tokens: maxTokens,
      temperature,
      system: "",
      messages: [{ role: "user", content: prompt }],
    });

    let text = "";
    for (const block of resp.content) {
      if (block.type === "text") text += block.text;
    }
    return cleanResponse(text);
  }

  // OpenAI-compatible (OpenAI, Google, custom)
  if (!llm.openaiClient) {
    throw new Error(`No client available for provider ${llm.provider}`);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];

  const resp = await llm.openaiClient.chat.completions.create({
    model: llm.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  const text = resp.choices[0]?.message?.content?.trim() || "";
  return cleanResponse(text);
}

// ─── Response cleaning ───

function cleanResponse(text: string): string {
  let cleaned = text.trim();
  // Strip markdown code fences — handle multiple fenced blocks by taking
  // the last one (LLMs often put the final answer in the last fence).
  if (cleaned.includes("```")) {
    const blocks = cleaned.split(/```+/);
    // blocks[0] is before first fence, blocks[1] is inside first fence, etc.
    // Odd indices are inside fences, even indices are outside.
    const fencedBlocks = blocks.filter((_, i) => i % 2 === 1);
    if (fencedBlocks.length > 0) {
      cleaned = fencedBlocks[fencedBlocks.length - 1];
    }
    // Remove leading language tag like "json\n"
    cleaned = cleaned.replace(/^(json|txt|text|md)\n/, "");
  }
  return cleaned.trim();
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
