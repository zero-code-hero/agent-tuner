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

// Evidence-based output. Each rule emits named facts the reviewer can verify
// without trusting a black-box verdict. The recommendation is deterministically
// derived from these facts (see deriveRecommendation).

export type SourceMode =
  // Truly unconditional: file content is in the model's context EVERY turn,
  // for every task. Rule duplicates here are genuinely free.
  | "auto-loaded"
  // Skill description (frontmatter) is in context every turn, but the body
  // only loads when Claude's analysis matches the description — not guaranteed
  // for every task that touches the skill's domain. Per Claude Code docs.
  | "conditional-load"
  // README and similar commonly-read-early files. Not unconditional, but
  // typically present before the agent does real work.
  | "auto-included"
  // Agent has to know to look. Runbooks, Swimm guides, docs/.
  | "manual-reference"
  // Subagent definition file (.claude/agents/*.md) — agent loads when invoked.
  | "subagent"
  // Agent inferred from source code.
  | "source-code"
  // Config file (package.json, tsconfig, etc.)
  | "config"
  | "unknown";

export interface SourceCitation {
  path: string;          // relative to repo root
  mode: SourceMode;
  modeNote: string;      // human-friendly mode explanation, e.g. "auto-activates on .php edits"
}

export type AgentBehavior =
  | { kind: "matched-rule"; confidence: number }
  | { kind: "partial-match"; confidence: number; missing: string }
  | { kind: "failed-to-answer"; confidence: number; reason: string };

export type Recommendation =
  | "safe-to-drop"            // covered fully by auto-loaded/auto-activated source
  | "keep-for-discoverability" // covered only by manual-reference sources
  | "rephrase-with-nuance"    // has duplicates but rule adds something they miss
  | "keep-essential"          // no doc covers it; agent couldn't infer
  | "unsure";                 // agent answered but no clear source — manual review

export interface AuditedRule {
  rule: ExistingRule;
  // The probe used to test the rule
  probeQuestion: string;
  probeAnswer: string | null;
  probeConfidence: number;
  // Evidence — checkable facts
  duplicatedIn: SourceCitation[];   // where the rule's content already exists; empty if none
  addsBeyondDuplicates: string | null; // what the rule uniquely contributes; null if pure duplicate or no duplicates
  agentBehaviorWithoutRule: AgentBehavior;
  // Derived (deterministically from evidence above)
  recommendation: Recommendation;
  recommendationReason: string;
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

// ─── Nuance judge ───
//
// For each rule that the fresh agent answered confidently (would-be-redundant),
// ask an LLM whether the agent's answer FULLY captures the rule's content +
// nuance. If something is missing (a caveat, a specific identifier, a "do this
// even though"-style exception), downgrade redundant → partial-coverage.
//
// Without this check, two rules paraphrased differently on the same topic
// would each get marked redundant because the agent finds the basic info
// elsewhere — losing the rule's unique nuance if the user prunes.

const NUANCE_PROMPT = `You are judging whether an AI agent's answer fully captures the content of a rule from an AGENTS.md file.

The rule:
"""
{rule}
"""

The probing question asked:
"""
{question}
"""

The agent's answer (the agent did NOT have access to AGENTS.md):
"""
{answer}
"""

Compare the rule against the answer. Does the answer cover:
- The same key facts the rule states?
- Any specific identifiers, file paths, commands, or terms?
- Any caveats, exceptions, "unless", "even though", "but never" constraints?
- The same actionable instruction?

If the answer captures everything the rule teaches, return covered: true.
If the answer misses anything meaningful (a caveat, a specific name, an
exception, a "do this in case X" specifier), return covered: false and
describe what's missing in one short sentence.

Be strict — better to flag partial coverage than miss a nuance.`;

async function judgeNuance(
  rule: string,
  question: string,
  answer: string,
  model: string,
  baseUrl: string | undefined,
): Promise<{ covered: boolean; missing?: string }> {
  const schema = {
    type: "object" as const,
    properties: {
      covered: { type: "boolean" },
      missing: { type: "string", description: "What the answer didn't capture (empty when covered=true)" },
    },
    required: ["covered", "missing"],
    additionalProperties: false,
  };

  try {
    const llm = createLLMClient({ model, baseUrl });
    const prompt = NUANCE_PROMPT
      .replace("{rule}", rule)
      .replace("{question}", question)
      .replace("{answer}", answer);
    const result = await callLLMStructured<{ covered: boolean; missing: string }>(
      llm,
      prompt,
      schema,
      "submit_nuance_judgment",
      "Submit a strict nuance-coverage verdict.",
      1024,
    );
    return {
      covered: Boolean(result?.covered),
      missing: result?.missing && result.missing.trim() !== "" ? result.missing : undefined,
    };
  } catch (e: any) {
    // On judge failure, fall back to conservative "not covered" so we
    // err on keeping the rule rather than losing nuance.
    if (process.env.DEBUG) console.warn(`⚠️  Nuance judge failed: ${e.message}. Defaulting to partial-coverage.`);
    return { covered: false, missing: `nuance judge errored (${e.message})` };
  }
}

// ─── Source-mode classifier (path-based, deterministic) ───
//
// Given a file path, decide HOW an agent would normally encounter it during
// real work. This is the key knob: a rule's info living in an "auto-loaded"
// file means the agent sees it for free; living in "manual-reference" means
// the agent only sees it if it knows to look — so the rule pointing at it
// has independent discoverability value.

export function classifySource(rawPath: string): SourceCitation {
  // Normalize away the worktree prefix and leading slash
  const norm = rawPath
    .replace(/^.*?\/agent-tuner-worktree-[^/]+\//, "")
    .replace(/^\/+/, "");

  const last = norm.split("/").pop() || norm;

  // AI-rules files at root (auto-loaded by their respective tools)
  if (last === "AGENTS.md" || last === "CLAUDE.md") {
    return { path: norm, mode: "auto-loaded", modeNote: "auto-loaded by Claude Code in non-bare mode" };
  }
  if (norm.startsWith(".cursor/")) {
    return { path: norm, mode: "auto-loaded", modeNote: "auto-loaded by Cursor" };
  }
  if (norm.startsWith(".windsurfrules") || norm.startsWith(".clinerules")) {
    return { path: norm, mode: "auto-loaded", modeNote: "auto-loaded by its respective tool" };
  }

  // Skills — only the frontmatter description is unconditionally in context.
  // The SKILL.md body loads conditionally when the model's analysis matches
  // the description, so a rule's content living in the body is NOT reliably
  // available — only when this turn's task happens to match the description.
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(norm)) {
    const skillName = norm.split("/")[2];
    return { path: norm, mode: "conditional-load", modeNote: `${skillName} skill: description always in context, body loads only when description matches the task` };
  }
  if (/^\.claude\/skills\/[^/]+\.(yaml|yml)$/.test(norm)) {
    return { path: norm, mode: "conditional-load", modeNote: "skill manifest: description always in context, body conditional" };
  }

  // Subagent definitions
  if (norm.startsWith(".claude/agents/")) {
    return { path: norm, mode: "subagent", modeNote: "subagent definition; invoked by Task tool" };
  }

  // Runbooks, Swimm, docs — manual references
  if (norm.startsWith(".claude/runbooks/")) {
    return { path: norm, mode: "manual-reference", modeNote: "runbook; agent must know to read it" };
  }
  if (norm.startsWith(".swm/")) {
    return { path: norm, mode: "manual-reference", modeNote: "Swimm doc; agent must know to read it" };
  }
  if (norm.startsWith("docs/")) {
    return { path: norm, mode: "manual-reference", modeNote: "in docs/; agent must know to read it" };
  }

  // README — usually one of the first reads
  if (/(^|\/)README\.md$/i.test(norm)) {
    return { path: norm, mode: "auto-included", modeNote: "README; typically read early" };
  }

  // Copilot
  if (norm === ".github/copilot-instructions.md") {
    return { path: norm, mode: "auto-loaded", modeNote: "auto-loaded by GitHub Copilot" };
  }

  // Source code
  if (/\.(ts|tsx|js|jsx|mjs|cjs|php|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp)$/i.test(norm)) {
    return { path: norm, mode: "source-code", modeNote: "source file; agent inferred from reading code" };
  }

  // Config
  if (/^(package|tsconfig|composer|Cargo|pyproject|Gemfile|build\.gradle)/.test(last)) {
    return { path: norm, mode: "config", modeNote: "config file" };
  }
  if (/\.(json|toml|yaml|yml|ini|env|xml|gradle|mk|sh)$/i.test(last)) {
    return { path: norm, mode: "config", modeNote: "config / script file" };
  }

  return { path: norm, mode: "unknown", modeNote: "" };
}

// ─── Recommendation (derived from evidence) ───

function deriveRecommendation(
  duplicatedIn: SourceCitation[],
  addsBeyondDuplicates: string | null,
  behavior: AgentBehavior,
): { recommendation: Recommendation; reason: string } {
  // Agent couldn't answer → rule is essential.
  if (behavior.kind === "failed-to-answer") {
    return {
      recommendation: "keep-essential",
      reason: `fresh agent couldn't infer this without the rule (confidence ${behavior.confidence.toFixed(2)}; ${behavior.reason})`,
    };
  }

  // Agent answered partially → nuance is missing.
  if (behavior.kind === "partial-match") {
    return {
      recommendation: "rephrase-with-nuance",
      reason: `agent partially answered but missed: ${behavior.missing}`,
    };
  }

  // Agent matched the rule fully but nuance judge flagged something — keep with rephrase
  if (addsBeyondDuplicates && addsBeyondDuplicates.trim().length > 0) {
    return {
      recommendation: "rephrase-with-nuance",
      reason: `rule uniquely contributes: ${addsBeyondDuplicates}`,
    };
  }

  // Agent matched and no nuance gap — check where it found the info.
  if (duplicatedIn.length === 0) {
    // No cited duplicates — answer probably came from code inference, training, or unattributed.
    return {
      recommendation: "unsure",
      reason: "agent answered confidently but cited no specific source; could be training-data, code inference, or unattributed read",
    };
  }

  // Only TRULY unconditional sources count as drop-safe. AGENTS.md, CLAUDE.md,
  // .cursor/rules — files whose content is in the model's context every turn,
  // for every task.
  const trulyAutoLoaded = duplicatedIn.filter((d) => d.mode === "auto-loaded");
  if (trulyAutoLoaded.length > 0) {
    return {
      recommendation: "safe-to-drop",
      reason: `covered by ${trulyAutoLoaded.map((d) => `${d.path} (${d.modeNote})`).join("; ")} — agent gets this unconditionally`,
    };
  }

  // Conditional-load (SKILL bodies) and manual-reference (runbooks/swim/docs)
  // both require something to fire before the rule's content reaches the
  // agent: a description match for skills, or an explicit read for runbooks.
  // Neither is reliable enough to drop the AGENTS.md rule; both qualify as
  // keep-for-discoverability.
  const conditionalOrManual = duplicatedIn.filter(
    (d) => d.mode === "conditional-load" || d.mode === "manual-reference" || d.mode === "subagent" || d.mode === "auto-included",
  );
  if (conditionalOrManual.length > 0) {
    const notes = conditionalOrManual.map((d) => `${d.path} (${d.modeNote || d.mode})`);
    return {
      recommendation: "keep-for-discoverability",
      reason: `info exists in ${notes.join("; ")} — those aren't unconditionally loaded, so the rule still provides reliable coverage`,
    };
  }

  // Source or config only
  const codeOrConfig = duplicatedIn.filter((d) => d.mode === "source-code" || d.mode === "config");
  if (codeOrConfig.length > 0) {
    return {
      recommendation: "unsure",
      reason: `agent inferred from ${codeOrConfig.slice(0, 3).map((d) => d.path).join(", ")} — keep if rule formalizes an implicit convention, drop if agent will always re-infer`,
    };
  }

  return {
    recommendation: "unsure",
    reason: "no clear signal from evidence",
  };
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

  // Match each rule to its probe result.
  type Pending = {
    rule: ExistingRule;
    probe: string;
    result?: QuestionResult;
  };
  const pending: Pending[] = rules.map((rule, i) => ({
    rule,
    probe: probeQuestions[i],
    result: results.find((r) => r.questionId === rule.questionId),
  }));

  // Nuance-judge every rule the agent answered confidently. This is what
  // populates `addsBeyondDuplicates` — the rule's unique nuance the
  // agent's answer didn't capture (if any).
  const answered = pending.filter((p) => p.result?.answered && p.result?.answer);
  if (answered.length > 0) {
    console.log(`🧐 Nuance-judging ${answered.length} answered rule(s) for content coverage...`);
  }
  const CONCURRENCY = 6;
  const nuanceVerdicts = new Map<string, { covered: boolean; missing?: string }>();
  for (let i = 0; i < answered.length; i += CONCURRENCY) {
    const batch = answered.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((p) =>
        judgeNuance(p.rule.content, p.probe, p.result!.answer!, model, baseUrl)
          .then((v) => ({ id: p.rule.questionId, v })),
      ),
    );
    for (const { id, v } of batchResults) nuanceVerdicts.set(id, v);
  }

  // Final pass: emit evidence-based AuditedRule per rule.
  const audited: AuditedRule[] = pending.map((p) => {
    const probeAnswer = p.result?.answer || null;
    const probeConfidence = p.result?.confidence ?? 0;

    // Sources the agent self-reported as evidence — classify each.
    const duplicatedIn: SourceCitation[] = (p.result?.evidence || []).map(classifySource);

    // Behavior: did the agent match the rule, partially match, or fail?
    let behavior: AgentBehavior;
    if (!p.result) {
      behavior = { kind: "failed-to-answer", confidence: 0, reason: "no probe result" };
    } else if (!p.result.answered) {
      behavior = {
        kind: "failed-to-answer",
        confidence: probeConfidence,
        reason: p.result.failureReason || p.result.docsNeeded || "below confidence threshold or docs needed",
      };
    } else {
      const nuance = nuanceVerdicts.get(p.rule.questionId);
      if (nuance && !nuance.covered && nuance.missing) {
        behavior = { kind: "partial-match", confidence: probeConfidence, missing: nuance.missing };
      } else {
        behavior = { kind: "matched-rule", confidence: probeConfidence };
      }
    }

    // What the rule uniquely adds — from nuance judge for matched cases,
    // or the partial-match missing-content for partial cases.
    let addsBeyondDuplicates: string | null = null;
    if (behavior.kind === "partial-match") addsBeyondDuplicates = behavior.missing;

    const { recommendation, reason } = deriveRecommendation(duplicatedIn, addsBeyondDuplicates, behavior);

    return {
      rule: p.rule,
      probeQuestion: p.probe,
      probeAnswer,
      probeConfidence,
      duplicatedIn,
      addsBeyondDuplicates,
      agentBehaviorWithoutRule: behavior,
      recommendation,
      recommendationReason: reason,
    };
  });

  return audited;
}

// ─── Reporting ───

// Evidence-based output. For each rule prints the named facts, then the
// derived recommendation. The reviewer can verify each fact by reading the
// cited file path — no opaque verdict.
export function summarizeAudit(audited: AuditedRule[]): string {
  if (audited.length === 0) return "";

  // Group by recommendation
  const byRec: Record<Recommendation, AuditedRule[]> = {
    "keep-essential": [],
    "rephrase-with-nuance": [],
    "keep-for-discoverability": [],
    "safe-to-drop": [],
    "unsure": [],
  };
  for (const a of audited) byRec[a.recommendation].push(a);

  const lines: string[] = [];
  lines.push("");
  lines.push("─".repeat(78));
  lines.push(`  Existing-rule audit (${audited.length} rules):`);
  lines.push(`    keep-essential:           ${byRec["keep-essential"].length}`);
  lines.push(`    rephrase-with-nuance:     ${byRec["rephrase-with-nuance"].length}`);
  lines.push(`    keep-for-discoverability: ${byRec["keep-for-discoverability"].length}`);
  lines.push(`    safe-to-drop:             ${byRec["safe-to-drop"].length}`);
  lines.push(`    unsure (review manually): ${byRec["unsure"].length}`);
  lines.push("─".repeat(78));

  const sectionHeaders: Array<[Recommendation, string]> = [
    ["keep-essential", "✅ KEEP — Essential (fresh agent couldn't infer without the rule)"],
    ["rephrase-with-nuance", "⚠️  REPHRASE — Has duplicates but rule uniquely contributes nuance"],
    ["keep-for-discoverability", "📌 KEEP — For discoverability (info only in manual-reference docs)"],
    ["safe-to-drop", "🔻 DROP — Fully covered by auto-loaded/auto-activated source"],
    ["unsure", "❓ MANUAL REVIEW — Evidence inconclusive"],
  ];

  for (const [rec, header] of sectionHeaders) {
    const rules = byRec[rec];
    if (rules.length === 0) continue;
    lines.push("");
    lines.push(header);
    for (const a of rules) {
      lines.push("");
      lines.push(`  [${a.rule.section}:L${a.rule.lineNumber}] "${a.rule.content.slice(0, 120)}${a.rule.content.length > 120 ? "…" : ""}"`);
      // Print evidence: cited duplicates with mode notes
      if (a.duplicatedIn.length > 0) {
        lines.push(`    DUPLICATED IN:`);
        for (const d of a.duplicatedIn) {
          lines.push(`      - ${d.path}  (${d.modeNote || d.mode})`);
        }
      } else {
        lines.push(`    DUPLICATED IN:           (no cited source)`);
      }
      // What the rule adds
      const adds = a.addsBeyondDuplicates;
      lines.push(`    ADDS BEYOND DUPLICATES:  ${adds ? adds : "nothing the agent's answer missed"}`);
      // Agent behavior
      const b = a.agentBehaviorWithoutRule;
      if (b.kind === "matched-rule") {
        lines.push(`    AGENT BEHAVIOR W/O RULE: matched the rule (confidence ${b.confidence.toFixed(2)})`);
      } else if (b.kind === "partial-match") {
        lines.push(`    AGENT BEHAVIOR W/O RULE: partial match (confidence ${b.confidence.toFixed(2)}); missing: ${b.missing}`);
      } else {
        lines.push(`    AGENT BEHAVIOR W/O RULE: failed to answer (confidence ${b.confidence.toFixed(2)}); ${b.reason}`);
      }
      lines.push(`    RECOMMENDATION:          ${a.recommendation}`);
      lines.push(`    REASON:                  ${a.recommendationReason}`);
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
      // Rule identity
      section: a.rule.section,
      lineNumber: a.rule.lineNumber,
      content: a.rule.content,
      // Probe & test
      probeQuestion: a.probeQuestion,
      probeAnswer: a.probeAnswer,
      probeConfidence: a.probeConfidence,
      // Evidence
      duplicatedIn: a.duplicatedIn,
      addsBeyondDuplicates: a.addsBeyondDuplicates,
      agentBehaviorWithoutRule: a.agentBehaviorWithoutRule,
      // Derived recommendation
      recommendation: a.recommendation,
      recommendationReason: a.recommendationReason,
    })),
  }, null, 2));
  return reportPath;
}
