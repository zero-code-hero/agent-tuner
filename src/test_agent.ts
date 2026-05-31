import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question, QuestionResult } from "./state.js";
import { freshAgentContext } from "./context_builder.js";
import { AgentRunner } from "./agent_runner.js";
import { tryParseJsonArray } from "./json_parse.js";

import { DEFAULT_MODEL } from "./constants.js";

const TEST_AGENT_PROMPT = `You are a completely FRESH AI agent dropped into this codebase.

You have NO prior knowledge. No AGENTS.md, no CLAUDE.md, no onboarding docs.
You have tools to explore: read files, run bash commands, grep, find, ls.

Your task: answer these questions by exploring the codebase. Use your tools.
- Read files to understand conventions, architecture, patterns
- Use grep/find to locate relevant code
- Be honest about what you can and cannot find

For each question, respond with a JSON object. Return ONLY a JSON array, no markdown, no explanation:

[
  {{"questionId": "q1", "answered": true, "answer": "the answer", "confidence": 0.9, "evidence": ["file1.ts", "package.json"], "docsNeeded": null}},
  {{"questionId": "q2", "answered": false, "answer": null, "confidence": 0.2, "evidence": [], "failureReason": "couldn't find X", "docsNeeded": "AGENTS.md should say: ..."}},
  ...
]

Questions:
{questions}

Codebase info:
{context}`;

export async function testFreshAgent(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  state: TunerState,
  questions: Question[],
  model: string = DEFAULT_MODEL,
  baseUrl?: string,
): Promise<QuestionResult[]> {
  const freshContext = freshAgentContext(info);

  const questionsText = questions
    .map((q) => `  - [${q.id}] (${q.category}, difficulty ${q.difficulty}) ${q.text}`)
    .join("\n");

  const prompt = TEST_AGENT_PROMPT
    .replace("{questions}", questionsText)
    .replace("{context}", freshContext);

  let lastError: unknown;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const runner = new AgentRunner({
      cwd: info.path,
      model,
      thinkingLevel: "off",
      noContextFiles: true, // CRITICAL: strip AGENTS.md / CLAUDE.md
      maxTurns: 30,
      baseUrl,
    });

    const result = await runner.run(prompt);
    if (result.error && !result.text) {
      lastError = new Error(`Fresh agent failed: ${result.error}`);
      if (attempt < maxRetries) {
        if (process.env.DEBUG) console.warn(`⚠️  Fresh agent attempt ${attempt + 1} failed (${result.error}), retrying...`);
        continue;
      }
      throw lastError;
    }

    const parsed = tryParseJsonArray(result.text);
    if (!parsed) {
      lastError = new Error("Fresh agent returned non-JSON");
      if (attempt < maxRetries) {
        if (process.env.DEBUG) console.warn(`⚠️  Fresh agent attempt ${attempt + 1} returned non-JSON, retrying...`);
        continue;
      }
      throw lastError;
    }

    const results: QuestionResult[] = [];
    const parsedSet = new Map(parsed.map((r: any) => [r.questionId, r]));

    for (const q of questions) {
      const r = parsedSet.get(q.id);
      if (r) {
        results.push({
          questionId: r.questionId,
          answered: Boolean(r.answered),
          answer: r.answer || undefined,
          confidence: Math.min(1, Math.max(0, r.confidence || 0)),
          evidence: r.evidence || [],
          failureReason: r.failureReason || undefined,
          docsNeeded: r.docsNeeded || undefined,
        });
      } else {
        results.push({
          questionId: q.id,
          answered: false,
          confidence: 0,
          evidence: [],
          failureReason: "Test agent did not respond to this question",
          docsNeeded: `Document: ${q.text}`,
        });
      }
    }

    if (process.env.DEBUG) {
      console.log(`🔧 Fresh agent made ${result.toolCalls.length} tool calls`);
      for (const tc of result.toolCalls) {
        const preview = (tc.result || "(no result)").slice(0, 80);
        console.log(`   ${tc.name}(${JSON.stringify(tc.args).slice(0, 60)}) → ${preview}`);
      }
    }

    return results;
  }
  throw lastError;
}
