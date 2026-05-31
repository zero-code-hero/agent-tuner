import type { RepoInfo, DepthAnalysis, Rule } from "./types.js";
import type { TunerState } from "./state.js";
import { infoToContext } from "./context_builder.js";
import { createLLMClient, callLLM, parseJSONResponse } from "./llm_client.js";

import { DEFAULT_MODEL } from "./constants.js";

const RULE_REFINEMENT_PROMPT = `You are converting observed knowledge gaps into precise AGENTS.md rules.

A fresh agent (with no documentation) failed to answer certain questions about this codebase.
Convert each gap into a clear, actionable rule that would prevent this failure.

Codebase context:
{context}

Gaps to convert:
{gaps}

Rules should be:
- SPECIFIC: reference actual file names, commands, patterns from this codebase
- ACTIONABLE: tell the agent exactly what to do
- CONCISE: one or two sentences max per rule
- CATEGORIZED: pick the best category from: setup, testing, conventions, architecture, error_handling, configuration, git, ci, deployment, gotchas, general

Respond with ONLY a JSON array, no markdown, no explanation:
[
  {{"category": "setup", "content": "the rule text", "confidence": 0.8}},
  ...
]`;

export async function generateRulesFromGaps(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  gaps: Array<{ question: string; docsNeeded: string }>,
  state: TunerState,
  model: string = DEFAULT_MODEL,
  baseUrl?: string,
): Promise<Rule[]> {
  if (gaps.length === 0) return [];

  const context = infoToContext(info, depthAnalysis, state);
  const gapsText = gaps.map((g, i) => `Gap #${i}:\n  Question: ${g.question}\n  Needed: ${g.docsNeeded}`).join("\n\n");

  const prompt = RULE_REFINEMENT_PROMPT
    .replace("{context}", context)
    .replace("{gaps}", gapsText);

  try {
    const llm = createLLMClient({ model, baseUrl });
    const text = await callLLM(llm, prompt, 0.3, 3000);

    const parsed = parseJSONResponse<Array<{ category: string; content: string; confidence: number }>>(text, []);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      if (process.env.DEBUG) console.warn("⚠️  LLM rule refinement returned invalid JSON, falling back to deterministic generation");
      return fallbackGenerateRules(gaps, info);
    }

    return parsed.map((r, i) => ({
      category: r.category || inferCategory(gaps[i]?.docsNeeded || "", info),
      content: cleanRuleContent(r.content || gaps[i]?.docsNeeded || ""),
      confidence: Math.min(1, Math.max(0, r.confidence || 0.7)),
    }));
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  LLM rule refinement failed (${e.message}), falling back to deterministic generation`);
    return fallbackGenerateRules(gaps, info);
  }
}

function fallbackGenerateRules(
  gaps: Array<{ question: string; docsNeeded: string }>,
  info: RepoInfo,
): Rule[] {
  const rules: Rule[] = [];

  for (const gap of gaps) {
    const category = inferCategory(gap.docsNeeded, info);
    const content = cleanRuleContent(gap.docsNeeded);

    if (content) {
      rules.push({
        category,
        content,
        confidence: 0.7,
      });
    }
  }

  return rules;
}

// Strip common prefixes and formatting artifacts so content is clean plain text.
// Formatting (headers, bullet points) is handled by consolidate() in llm_score.ts.
function cleanRuleContent(text: string): string {
  let content = text.trim();

  // Remove common prefixes
  content = content.replace(/^(AGENTS\.md should say:|Document:|Rule:|Note:)\s*/i, "");

  // Strip embedded markdown headers (## Setup, ## Testing, etc.)
  content = content.replace(/^## .+\n?/, "");

  // Strip leading bullet points
  content = content.replace(/^[-*]\s+/, "");

  return content.trim();
}

function inferCategory(text: string, info: RepoInfo): string {
  const lower = text.toLowerCase();
  if (lower.includes("install") || lower.includes("setup") || lower.includes("dependency")) return "setup";
  if (lower.includes("test")) return "testing";
  if (lower.includes("lint") || lower.includes("format") || lower.includes("style")) return "conventions";
  if (lower.includes("import") || lower.includes("naming") || lower.includes("convention")) return "conventions";
  if (lower.includes("architect") || lower.includes("structure") || lower.includes("module")) return "architecture";
  if (lower.includes("error") || lower.includes("catch") || lower.includes("handle")) return "error_handling";
  if (lower.includes("env") || lower.includes("config") || lower.includes("variable")) return "configuration";
  if (lower.includes("git") || lower.includes("commit") || lower.includes("branch")) return "git";
  if (lower.includes("docker") || lower.includes("deploy")) return "deployment";
  if (lower.includes("gotcha") || lower.includes("pitfall") || lower.includes("watch out")) return "gotchas";
  return "general";
}
