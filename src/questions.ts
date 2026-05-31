import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question } from "./state.js";
import { infoToContext } from "./context_builder.js";
import { AgentRunner } from "./agent_runner.js";
import { tryParseJsonArray } from "./json_parse.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

const QUESTION_GENERATOR_PROMPT = `You are an adversarial question generator. Explore this codebase deeply and generate questions that would stump a NEW developer (or AI agent) with NO prior knowledge.

You have tools: read, bash, grep, find, ls. USE THEM. Read actual files. Explore the code.

What makes a good question:
- Something non-obvious that requires knowing unwritten conventions
- Hidden config, gotchas, anti-patterns specific to this codebase
- Non-trivial setup steps, environment requirements
- Architecture decisions that aren't documented
- Things a fresh agent would get stuck on

What makes a BAD question:
- Trivial ("what language is this?")
- Something obvious from file names alone
- Generic questions that apply to any project

Depth level: {depth} (1=surface/setup, 2=patterns/conventions, 3=architecture, 4=anti-patterns/gotchas)

{previousQuestions}
{previousFailures}

Codebase context:
{context}

Read files. Explore directories. Find the hidden stuff. Then generate {count} NEW questions.

Respond with ONLY a JSON array, no markdown, no explanation:
[
  {{"id": "q1", "text": "the question", "category": "setup|testing|conventions|architecture|gotchas", "difficulty": 1-5}},
  ...
]`;

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

  let lastError: unknown;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const runner = new AgentRunner({
      cwd: info.path,
      model,
      thinkingLevel: "off",
      noContextFiles: false, // generator can see existing docs
      maxTurns: 20,
      baseUrl,
    });

    const result = await runner.run(prompt);
    if (result.error && !result.text) {
      lastError = new Error(`Question generation failed: ${result.error}`);
      if (attempt < maxRetries) {
        if (process.env.DEBUG) console.warn(`⚠️  Question generation attempt ${attempt + 1} failed (${result.error}), retrying...`);
        continue;
      }
      throw lastError;
    }

    const parsed = tryParseJsonArray(result.text);
    if (!parsed || !Array.isArray(parsed)) {
      lastError = new Error("Question generator returned non-JSON");
      if (attempt < maxRetries) {
        if (process.env.DEBUG) console.warn(`⚠️  Question generation attempt ${attempt + 1} returned non-JSON, retrying...`);
        continue;
      }
      throw lastError;
    }

    const askedTexts = new Set(state.allQuestions.map((q) => normalize(q.text)));
    const unique = parsed.filter((q: any) => !askedTexts.has(normalize(q.text)));

    return unique.map((q: any, i: number) => ({
      id: `iter${state.currentIteration}_q${i}`,
      text: q.text,
      category: q.category || "general",
      difficulty: q.difficulty || 1,
      depth,
    }));
  }
  throw lastError;
}
