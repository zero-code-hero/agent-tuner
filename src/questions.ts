import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question } from "./state.js";
import { infoToContext } from "./context_builder.js";
import { createLLMClient, callLLMStructured } from "./llm_client.js";

import { DEFAULT_MODEL } from "./constants.js";

const QUESTION_GENERATOR_PROMPT = `You are an adversarial question generator. Generate questions that would stump a NEW developer (or AI agent) with NO prior knowledge of this codebase.

You CANNOT explore the filesystem directly in this call — you must reason entirely from the rich codebase context provided below (which already contains directory layouts, configs, CI workflows, package metadata, depth-specific extracts, and prior-iteration gaps).

What makes a good question:
- Something non-obvious that requires knowing unwritten conventions
- Hidden config, gotchas, anti-patterns specific to this codebase
- Non-trivial setup steps, environment requirements
- Architecture decisions that aren't documented in obvious places
- Things a fresh agent would plausibly get stuck on
- Reference real file paths, scripts, env vars, or commands visible in the context

What makes a BAD question:
- Trivial ("what language is this?")
- Something obvious from file names alone
- Generic questions that apply to any project
- Anything you cannot ground in the context below

Depth level: {depth} (1=surface/setup, 2=patterns/conventions, 3=architecture, 4=anti-patterns/gotchas)

{previousQuestions}
{previousFailures}

Codebase context:
{context}

Generate exactly {count} NEW questions grounded in the context. Return them via the submit_questions tool.`;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function generateQuestions(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  state: TunerState,
  model: string = DEFAULT_MODEL,
  baseUrl?: string,
): Promise<Question[]> {
  const context = infoToContext(info, depthAnalysis, state);
  const depth = state.currentDepth;
  const count = Math.min(5 + depth * 2, 15);

  const askedBefore = state.allQuestions.map((q) => `  - [${q.category}] ${q.text}`);
  const previousQuestions = askedBefore.length > 0
    ? `Already asked (DO NOT repeat, even rephrased):\n${askedBefore.join("\n")}\n\n`
    : "No questions asked yet.\n\n";

  const failures = state.allResults.filter((r) => !r.answered);
  const previousFailures = failures.length > 0
    ? `Previous iteration gaps (fresh agent failed on these):\n${failures.map((f) => `  - ${f.failureReason || "unknown"}\n`).join("")}\n\nUse these to generate HARDER, more targeted questions.`
    : "No previous failures.";

  const prompt = QUESTION_GENERATOR_PROMPT
    .replace("{context}", context)
    .replace("{depth}", String(depth))
    .replace("{count}", String(count))
    .replace("{previousQuestions}", previousQuestions)
    .replace("{previousFailures}", previousFailures);

  const schema = {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        minItems: Math.min(count, 3),
        maxItems: count,
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "The question" },
            category: {
              type: "string",
              enum: ["setup", "testing", "conventions", "architecture", "gotchas"],
            },
            difficulty: { type: "integer", minimum: 1, maximum: 5 },
          },
          required: ["text", "category", "difficulty"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  let lastError: unknown;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const llm = createLLMClient({ model, baseUrl });
      const result = await callLLMStructured<{ questions: Array<{ text: string; category: string; difficulty: number }> }>(
        llm,
        prompt,
        schema,
        "submit_questions",
        "Submit the list of adversarial questions for a fresh agent to attempt.",
      );

      if (!result?.questions || !Array.isArray(result.questions)) {
        throw new Error("Structured response missing 'questions' array");
      }

      const askedTexts = new Set(state.allQuestions.map((q) => normalize(q.text)));
      const unique = result.questions.filter((q) => !askedTexts.has(normalize(q.text)));

      return unique.map((q, i) => ({
        id: `iter${state.currentIteration}_q${i}`,
        text: q.text,
        category: q.category || "general",
        difficulty: q.difficulty || 1,
        depth,
      }));
    } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries) {
        if (process.env.DEBUG) console.warn(`⚠️  Question generation attempt ${attempt + 1} failed (${e.message}), retrying...`);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}
