import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question, QuestionResult } from "./state.js";
import { freshAgentContext } from "./context_builder.js";
import { AgentRunner } from "./agent_runner.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

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

function tryParseJsonArray(text: string): Array<any> | null {
  let cleaned = text;
  if (cleaned.startsWith("```")) {
    const inner = cleaned.split("```");
    cleaned = inner.length >= 3 ? inner[1] : inner[2] || cleaned;
    if (cleaned.match(/^(json|txt|text)\n/)) {
      cleaned = cleaned.replace(/^(json|txt|text)\n/, "");
    }
  }
  cleaned = cleaned.trim();
  const bracketMatch = cleaned.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

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
    throw new Error(`Fresh agent failed: ${result.error}`);
  }

  const parsed = tryParseJsonArray(result.text);
  if (!parsed) {
    throw new Error("Fresh agent returned non-JSON");
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
