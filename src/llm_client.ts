import { OpenAI } from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources";
import { tryParseJsonObject } from "./json_parse.js";

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
      // Anthropic SDK appends `/v1/messages` itself — must NOT include `/v1` here,
      // else requests go to `/v1/v1/messages` → 404. Return undefined to use the
      // SDK's default (`https://api.anthropic.com`).
      return undefined;
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
    // Newer Anthropic models (opus-4-8+) deprecate `temperature` and reject
    // it outright. Older models still accept it. Detect by model id pattern
    // and only pass it when supported.
    const supportsTemperature = !/^claude-(opus|sonnet|haiku)-4-([89]|\d{2,})/.test(llm.model);

    const req: any = {
      model: llm.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (supportsTemperature) req.temperature = temperature;

    const resp = await llm.anthropicClient.messages.create(req);

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

// ─── Structured output ───
// Force the model to return a JSON object matching a schema. For Anthropic
// we use the tool-forced output pattern (define a single tool, force it via
// tool_choice). For OpenAI-compatible providers we use response_format with
// json_schema where supported, falling back to plain JSON-mode parsing.
//
// This is the right fix for newer Anthropic models (opus-4-8+, sonnet-4-6+)
// that habitually narrate their work instead of producing JSON, even when
// the prompt says "JSON ONLY". Tool-forced output is a hard constraint, not
// a polite request — the model literally cannot return anything else.

export interface JsonSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export async function callLLMStructured<T = any>(
  llm: LLMClient,
  prompt: string,
  schema: JsonSchema,
  toolName: string = "respond",
  toolDescription: string = "Return the response in the required structured format.",
  maxTokens: number = 8192,
): Promise<T> {
  // Anthropic: tool-forced JSON output
  if (llm.anthropicClient) {
    const resp = await llm.anthropicClient.messages.create({
      model: llm.model,
      max_tokens: maxTokens,
      tools: [{
        name: toolName,
        description: toolDescription,
        input_schema: schema as any,
      }],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: prompt }],
    });

    for (const block of resp.content) {
      if (block.type === "tool_use" && block.name === toolName) {
        return block.input as T;
      }
    }
    throw new Error(`Anthropic returned no tool_use block for ${toolName}`);
  }

  // OpenAI-compatible: response_format with json_schema (supported by gpt-4o,
  // gpt-4o-mini, and most modern OpenAI-compatible servers). If the server
  // rejects it we fall through to a plain JSON-mode call and parse text.
  if (!llm.openaiClient) {
    throw new Error(`No client available for provider ${llm.provider}`);
  }

  try {
    const resp = await llm.openaiClient.chat.completions.create({
      model: llm.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: toolName,
          schema: schema as any,
          strict: true,
        },
      } as any,
    });
    const text = resp.choices[0]?.message?.content?.trim() || "";
    return JSON.parse(text) as T;
  } catch (e: any) {
    // Fallback: ask for JSON object via response_format and parse loosely
    const resp = await llm.openaiClient.chat.completions.create({
      model: llm.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      response_format: { type: "json_object" } as any,
    });
    const text = resp.choices[0]?.message?.content?.trim() || "";
    return JSON.parse(text) as T;
  }
}

// ─── Response cleaning ───
// Try to return clean text without aggressively stripping content.
// Only extract from fences when the outer text won't parse as-is.
function cleanResponse(text: string): string {
  let cleaned = text.trim();

  // If it already parses as JSON, return it directly — no fence stripping needed.
  try { JSON.parse(cleaned); return cleaned; } catch {}

  // Only strip fences as a fallback. Take the last fenced block (LLMs often
  // put the final answer in the last fence). Use a regex that matches balanced
  // ``` pairs instead of naive splitting, which breaks on odd fence counts.
  if (cleaned.includes("```")) {
    const fenceRegex = /```(?:\w*)\n?([\s\S]*?)```/g;
    let lastMatch: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(cleaned)) !== null) {
      lastMatch = m[1];
    }
    if (lastMatch !== null) {
      cleaned = lastMatch;
    }
    // Remove leading language tag like "json\n"
    cleaned = cleaned.replace(/^(json|txt|text|md)\n/, "");
  }
  return cleaned.trim();
}

// ─── JSON parsing (delegated to unified parser in json_parse.ts) ───

export function parseJSONResponse<T>(text: string, fallback: T): T {
  return tryParseJsonObject(text, fallback);
}
