// Audit existing rules in AGENTS.md / CLAUDE.md to figure out which ones are
// actually essential vs. ones a fresh agent can derive from the code anyway.
//
// Algorithm:
//   1. Parse the existing AGENTS.md into individual rules (markdown bullets
//      grouped by ## section headers).
//   2. For each rule, ask an LLM to phrase it as a probing question — one
//      a fresh agent (with no docs) could answer if and only if it knew the
//      rule.
//   3. Run those questions through the same fresh-agent harness used by the
//      adversarial loop (docs hidden, tools enabled, claude CLI or Pi SDK).
//   4. Classify each rule:
//      - essential  : agent failed OR low confidence OR docsNeeded set.
//                     The rule is doing real work — keep it.
//      - redundant  : agent answered confidently AND no docsNeeded. The
//                     answer was discoverable from code; the rule may not
//                     be earning its keep.
//      - uncertain  : the probe didn't return cleanly (parse error etc.).
//
// We never auto-remove rules — only flag. Output is a JSON report and a
// human-readable summary the caller can show alongside new-rule output.

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question, QuestionResult } from "./state.js";
import { testFreshAgent } from "./test_agent.js";
import { createLLMClient, callLLMStructured } from "./llm_client.js";
import { DEFAULT_MODEL } from "./constants.js";
import type { RunnerBackend } from "./agent_runner.js";

export interface ExistingRule {
  section: string;           // e.g. "Setup", "Testing"
  content: string;           // the rule text (no leading "- ")
  lineNumber: number;        // 1-indexed in the source file
  questionId: string;        // generated id used to link probe → verdict
}

export type RuleVerdict = "essential" | "redundant" | "uncertain";

export interface AuditedRule {
  rule: ExistingRule;
  verdict: RuleVerdict;
  probeQuestion: string;
  probeResult?: QuestionResult;
  reason: string;
}

// ─── Parsing ───

export function parseAgentsFile(path: string): ExistingRule[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  const rules: ExistingRule[] = [];
  let currentSection = "General";
  let ruleIdx = 0;
  // Buffer for multi-line bullets ("- foo\n  more foo")
  let buffer: { content: string; section: string; lineNumber: number } | null = null;

  const flush = () => {
    if (!buffer) return;
    const content = buffer.content.trim();
    if (content) {
      rules.push({
        section: buffer.section,
        content,
        lineNumber: buffer.lineNumber,
        questionId: `existing_${ruleIdx++}`,
      });
    }
    buffer = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headerMatch) {
      flush();
      currentSection = headerMatch[1];
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      flush();
      buffer = { content: bulletMatch[1], section: currentSection, lineNumber: i + 1 };
      continue;
    }
    // Continuation line (indented under a bullet)
    if (buffer && /^\s+\S/.test(line)) {
      buffer.content += " " + line.trim();
      continue;
    }
    // Blank line / non-bullet content — close the current bullet
    if (buffer && line.trim() === "") {
      flush();
    }
  }
  flush();
  return rules;
}

// ─── Probe generation ───

const PROBE_PROMPT = `You are turning AGENTS.md rules into probing questions for a fresh AI agent.

For each rule below, write ONE probing question that:
- A fresh agent (with NO access to AGENTS.md) could only answer correctly if it KNEW the rule
- Is specific enough that "I don't know" / generic guessing would be wrong
- References real artifacts (file paths, commands, terms) so the answer is checkable
- Does NOT just restate the rule — it should probe whether the rule is *needed*

If a rule is too vague to probe (e.g. "Be careful"), still generate a question, but flag it by writing a question that asks for the specific actionable behaviour the rule implies.

Section: {section}
Rules (numbered):
{rules}

Return one question per rule, in order, via the submit_probes tool.`;

export async function generateProbes(
  rules: ExistingRule[],
  model: string,
  baseUrl?: string,
): Promise<string[]> {
  if (rules.length === 0) return [];

  // Batch by section so the LLM has coherent context per call.
  const bySection = new Map<string, ExistingRule[]>();
  for (const r of rules) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section)!.push(r);
  }

  const probesByRule = new Map<string, string>();

  for (const [section, sectionRules] of bySection.entries()) {
    const rulesText = sectionRules.map((r, i) => `${i + 1}. ${r.content}`).join("\n");
    const prompt = PROBE_PROMPT
      .replace("{section}", section)
      .replace("{rules}", rulesText);

    const schema = {
      type: "object" as const,
      properties: {
        probes: {
          type: "array",
          minItems: sectionRules.length,
          maxItems: sectionRules.length,
          items: {
            type: "object",
            properties: {
              ruleIndex: { type: "integer", minimum: 1 },
              question: { type: "string" },
            },
            required: ["ruleIndex", "question"],
            additionalProperties: false,
          },
        },
      },
      required: ["probes"],
      additionalProperties: false,
    };

    const llm = createLLMClient({ model, baseUrl });
    const wrapped = await callLLMStructured<{ probes: Array<{ ruleIndex: number; question: string }> }>(
      llm,
      prompt,
      schema,
      "submit_probes",
      "Submit one probing question per rule.",
    );

    for (const probe of wrapped?.probes || []) {
      const rule = sectionRules[probe.ruleIndex - 1];
      if (rule) probesByRule.set(rule.questionId, probe.question);
    }
  }

  // Return in input order; if any rule didn't get a probe, fall back to the
  // rule content itself as the question (so we still test something).
  return rules.map((r) => probesByRule.get(r.questionId) || `Explain the convention: ${r.content}`);
}

// ─── Audit ───

export async function auditExistingRules(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  state: TunerState,
  model: string,
  baseUrl: string | undefined,
  backend: RunnerBackend,
): Promise<AuditedRule[]> {
  const agentsPath = join(info.path, "AGENTS.md");
  const rules = parseAgentsFile(agentsPath);
  if (rules.length === 0) return [];

  console.log(`\n🔎 Auditing ${rules.length} existing rules in AGENTS.md...`);

  // Generate probing questions
  const probeQuestions = await generateProbes(rules, model, baseUrl);

  // Convert to Question[] for the test_agent
  const questions: Question[] = rules.map((r, i) => ({
    id: r.questionId,
    text: probeQuestions[i],
    category: r.section.toLowerCase(),
    difficulty: 3,
    depth: 0,
  }));

  // Run the fresh agent on those questions (docs hidden by testFreshAgent)
  const results = await testFreshAgent(info, depthAnalysis, state, questions, model, baseUrl, backend);

  // Classify each rule
  const audited: AuditedRule[] = rules.map((rule, i) => {
    const result = results.find((r) => r.questionId === rule.questionId);
    const probe = probeQuestions[i];
    if (!result) {
      return {
        rule,
        verdict: "uncertain" as RuleVerdict,
        probeQuestion: probe,
        reason: "no probe result returned",
      };
    }
    // The test_agent already applies the same gap criterion as the main loop:
    //   answered === true means confidence >= 0.75 AND no docsNeeded.
    if (result.answered) {
      return {
        rule,
        verdict: "redundant",
        probeQuestion: probe,
        probeResult: result,
        reason: `fresh agent answered without the rule (confidence ${result.confidence.toFixed(2)})`,
      };
    }
    return {
      rule,
      verdict: "essential",
      probeQuestion: probe,
      probeResult: result,
      reason: result.failureReason || `fresh agent could not answer (confidence ${result.confidence.toFixed(2)})`,
    };
  });

  return audited;
}

// ─── Reporting ───

export function summarizeAudit(audited: AuditedRule[]): string {
  if (audited.length === 0) return "";

  const essential = audited.filter((a) => a.verdict === "essential");
  const redundant = audited.filter((a) => a.verdict === "redundant");
  const uncertain = audited.filter((a) => a.verdict === "uncertain");

  const lines: string[] = [];
  lines.push("");
  lines.push("─".repeat(70));
  lines.push(`  Existing-rule audit: ${essential.length} essential, ${redundant.length} likely redundant, ${uncertain.length} uncertain`);
  lines.push("─".repeat(70));

  if (essential.length > 0) {
    lines.push("");
    lines.push("✅ Essential (keep — fresh agent failed without them):");
    for (const a of essential) {
      lines.push(`   [${a.rule.section}:L${a.rule.lineNumber}] ${a.rule.content.slice(0, 100)}${a.rule.content.length > 100 ? "…" : ""}`);
    }
  }

  if (redundant.length > 0) {
    lines.push("");
    lines.push("🔶 Likely redundant (review — fresh agent answered without them):");
    for (const a of redundant) {
      lines.push(`   [${a.rule.section}:L${a.rule.lineNumber}] ${a.rule.content.slice(0, 100)}${a.rule.content.length > 100 ? "…" : ""}`);
      lines.push(`      → ${a.reason}`);
    }
  }

  if (uncertain.length > 0) {
    lines.push("");
    lines.push("❓ Uncertain (probe didn't complete cleanly):");
    for (const a of uncertain) {
      lines.push(`   [${a.rule.section}:L${a.rule.lineNumber}] ${a.rule.content.slice(0, 100)}${a.rule.content.length > 100 ? "…" : ""}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function writeAuditReport(repoPath: string, audited: AuditedRule[]): string {
  const reportPath = join(repoPath, ".agent-tuner-audit-report.json");
  writeFileSync(reportPath, JSON.stringify({
    repoPath,
    timestamp: new Date().toISOString(),
    rules: audited.map((a) => ({
      section: a.rule.section,
      lineNumber: a.rule.lineNumber,
      content: a.rule.content,
      verdict: a.verdict,
      reason: a.reason,
      probeQuestion: a.probeQuestion,
      probeAnswer: a.probeResult?.answer,
      probeConfidence: a.probeResult?.confidence,
      probeDocsNeeded: a.probeResult?.docsNeeded,
    })),
  }, null, 2));
  return reportPath;
}
