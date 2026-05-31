import type { RepoInfo, DepthAnalysis, Rule, ScoredRule, KeptRule } from "./types.js";
import type { TunerState } from "./state.js";
import { infoToContext } from "./context_builder.js";
import { createLLMClient, callLLM, parseJSONResponse } from "./llm_client.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5-20250929";

const SCORE_PROMPT = `You are evaluating candidate rules for an AGENTS.md file. This file guides AI agents working in a codebase.

Your job: score each rule 1-10 for **actionable value** — would knowing this actually make the agent more effective?

Criteria:
- 9-10: Critical. Agent will fail or waste significant time without this.
- 7-8: High value. Substantially improves agent performance.
- 5-6: Moderate. Helpful but not essential.
- 3-4: Low. Nice to know but won't change behavior much.
- 1-2: Noise. Obvious, redundant, or too vague to act on.

Also flag rules that are:
- TOO VAGUE: doesn't give the agent something concrete to do
- REDUNDANT: duplicates another rule
- OBVIOUS: any competent agent already knows this
- STALE: might be outdated

Codebase context:
{context}

Candidate rules to evaluate:
{rules}

Respond with ONLY a JSON array, no markdown, no explanation:
[
  {{"index": 0, "score": 8, "keep": true, "reason": "reason", "suggestion": "optional improved version"}},
  ...
]`;

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        if (process.env.DEBUG) console.warn(`⚠️  ${label} attempt ${attempt + 1} failed (${e.message}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 80);
}

export async function scoreRules(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  rules: Rule[],
  state: TunerState,
  model: string = DEFAULT_MODEL,
  verbose: boolean = false,
  baseUrl?: string,
  threshold: number = 6,
): Promise<ScoredRule[]> {
  const context = infoToContext(info, depthAnalysis, state);
  const rulesText = rules.map((r, i) => `--- Rule #${i} (category: ${r.category}) ---\n${r.content}`).join("\n\n");

  const prompt = SCORE_PROMPT.replace("{context}", context).replace("{rules}", rulesText);

  try {
    const llm = createLLMClient({ model, baseUrl });
    const text = await withRetry(
      () => callLLM(llm, prompt, 0.1, 4000),
      2,
      "LLM scoring",
    );

    const results = parseJSONResponse<Array<{
      index: number; score: number; keep: boolean; reason: string; suggestion?: string;
    }>>(text, []);

    if (!Array.isArray(results)) {
      throw new Error("Scoring returned invalid JSON");
    }

    const scored: ScoredRule[] = [];
    const scoredIndices = new Set<number>();
    for (const r of results) {
      if (r.index < rules.length) {
        scored.push({
          index: r.index,
          score: r.score,
          keep: r.keep,
          reason: r.reason,
          suggestion: r.suggestion,
          original: rules[r.index],
        });
        scoredIndices.add(r.index);

        if (verbose) {
          const status = r.score >= 7 ? "✅" : r.score >= 5 ? "🔶" : "❌";
          console.log(`  ${status} Rule #${r.index} [${rules[r.index].category}]: ${r.score} — ${r.reason}`);
        }
      }
    }

    // Discard rules the scorer missed — we can't trust unscored rules
    const missedIndices: number[] = [];
    for (let i = 0; i < rules.length; i++) {
      if (!scoredIndices.has(i)) missedIndices.push(i);
    }
    if (missedIndices.length > 0) {
      console.warn(`⚠️  Scorer missed ${missedIndices.length} rule(s) (indices: ${missedIndices.join(", ")}). Discarding.`);
      for (const i of missedIndices) {
        scored.push({
          index: i,
          score: 0,
          keep: false,
          reason: "not evaluated by LLM scorer — discarded",
          original: rules[i],
        });
      }
    }

    return scored;
  } catch (e: any) {
    throw new Error(`LLM scoring failed: ${e.message}`);
  }
}

export function filterRules(scored: ScoredRule[], threshold: number = 6): KeptRule[] {
  return scored
    .filter((s) => s.keep && s.score >= threshold)
    .map((s) => ({
      category: s.original.category,
      content: s.suggestion || s.original.content,
      score: s.score,
      reason: s.reason,
    }));
}

export function consolidate(kept: KeptRule[]): string {
  if (kept.length === 0) {
    return "# AGENTS.md\n\nNo high-value rules detected. The codebase appears straightforward.\n";
  }

  // Group by category
  const sections: Record<string, string[]> = {};
  for (const r of kept) {
    if (!sections[r.category]) sections[r.category] = [];
    sections[r.category].push(r.content.trim());
  }

  const order = [
    "setup", "docs", "existing_agent", "testing", "conventions",
    "architecture", "imports", "error_handling", "configuration",
    "git", "ci", "deployment", "gotchas", "general",
  ];

  const display: Record<string, string> = {
    setup: "Setup", docs: "Documentation", existing_agent: "Existing Agent Instructions",
    testing: "Testing", conventions: "Conventions", architecture: "Architecture",
    imports: "Import Patterns", error_handling: "Error Handling", configuration: "Configuration",
    git: "Git", ci: "CI/CD", deployment: "Deployment", gotchas: "Gotchas & Pitfalls",
    general: "General",
  };

  const parts = ["# AGENTS.md", "", "Auto-generated by agent-tuner. Keep this file updated with `agent-tuner .`", ""];

  for (const cat of order) {
    if (!sections[cat]) continue;
    const deduped = semanticDedup(sections[cat]);
    if (deduped.length === 0) continue;

    const first = deduped[0];
    const headerMatch = first.match(/^(## .+)/);
    if (headerMatch) {
      parts.push(headerMatch[1]);
      for (const line of deduped) {
        const withoutHeader = line.replace(/^## .+\n?/, "").trim();
        if (withoutHeader) parts.push(withoutHeader);
      }
    } else {
      parts.push(`## ${display[cat] || cat}`);
      parts.push(...deduped);
    }
    parts.push("");
  }

  // Remaining categories not in order
  for (const cat of Object.keys(sections)) {
    if (order.includes(cat)) continue;
    const deduped = semanticDedup(sections[cat]);
    if (deduped.length === 0) continue;
    const first = deduped[0];
    const headerMatch = first.match(/^(## .+)/);
    if (headerMatch) {
      parts.push(headerMatch[1]);
      for (const line of deduped) {
        const withoutHeader = line.replace(/^## .+\n?/, "").trim();
        if (withoutHeader) parts.push(withoutHeader);
      }
    } else {
      parts.push(`## ${cat}`);
      parts.push(...deduped);
    }
    parts.push("");
  }

  return parts.join("\n");
}

function semanticDedup(items: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = normalizeForDedup(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}