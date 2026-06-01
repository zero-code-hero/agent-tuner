import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question, QuestionResult } from "./state.js";
import { freshAgentContext } from "./context_builder.js";
import { AgentRunner, type RunnerBackend } from "./agent_runner.js";
import { tryParseJsonArray } from "./json_parse.js";

// Files the fresh agent must NOT see — otherwise it bypasses the test by
// reading any doc file it can find. We:
//   1. Hide the well-known root files (AGENTS.md, CLAUDE.md, both casings).
//   2. Walk a curated set of doc directories (.claude/, docs/, .cursor/) up
//      to a shallow depth and hide any *.md / SKILL.md / runbook file there.
//   3. Truncate each to a placeholder string (not rename — earlier rename
//      approach was trivially bypassed by `ls` + Read).
//   4. Stash real contents in memory and restore in finally / signal handlers.
//
// Note: we deliberately do NOT hide README.md or per-package docstrings —
// those describe what the code is, not how to work in this codebase, and a
// fresh agent should be able to use them. The line we're drawing is "docs
// targeted at AI agents".
const HIDDEN_ROOT_DOCS = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"];
const HIDDEN_DOC_DIRS = [".claude", ".cursor", "docs/agents"];
const MAX_DEPTH = 4;
const PLACEHOLDER = "<intentionally blank during agent-tuner evaluation>\n";

interface StashedDoc {
  path: string;
  content: string;
}

function isHidableDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower === "skill.md" ||
    lower === "agents.md" ||
    lower === "claude.md"
  );
}

function collectDocFiles(root: string): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (st.isFile() && isHidableDocFile(entry)) {
        found.push(full);
      }
    }
  }
  return found;
}

function hideDocs(repoPath: string): StashedDoc[] {
  const stashed: StashedDoc[] = [];
  const toHide = new Set<string>();

  // Well-known root files
  for (const name of HIDDEN_ROOT_DOCS) {
    const p = join(repoPath, name);
    if (existsSync(p)) toHide.add(p);
  }

  // Agent-targeted doc directories
  for (const docDir of HIDDEN_DOC_DIRS) {
    const dirPath = join(repoPath, docDir);
    if (!existsSync(dirPath)) continue;
    for (const f of collectDocFiles(dirPath)) toHide.add(f);
  }

  for (const path of toHide) {
    try {
      const content = readFileSync(path, "utf-8");
      // Safety: if the file ALREADY contains only the placeholder, a previous
      // run crashed without restoring. Refuse to stash this — otherwise we'd
      // "restore" the placeholder as the real content, corrupting the file
      // permanently. Skip it (it's already hidden, that's fine for this run)
      // and warn loudly so the user can `git checkout` to recover.
      if (content.trim() === PLACEHOLDER.trim()) {
        console.error(`⚠️  ${path} contains only the agent-tuner placeholder — a previous run did not restore properly.`);
        console.error(`   Run: git checkout -- "${path}"   to restore from git, then re-run.`);
        continue;
      }
      writeFileSync(path, PLACEHOLDER);
      stashed.push({ path, content });
    } catch (e: any) {
      restoreDocs(stashed);
      throw new Error(`Could not stash ${path} before fresh-agent run: ${e.message}`);
    }
  }
  return stashed;
}

function restoreDocs(stashed: StashedDoc[]): void {
  for (const { path, content } of stashed) {
    try {
      writeFileSync(path, content);
    } catch (e: any) {
      console.error(`❌ FAILED to restore ${path}: ${e.message}`);
      console.error(`   Content was stashed in memory and is now lost. Recover via:`);
      console.error(`   git checkout -- ${path}`);
    }
  }
}

import { DEFAULT_MODEL } from "./constants.js";

const TEST_AGENT_PROMPT = `You are a completely FRESH AI agent dropped into this codebase.

You have NO prior knowledge. No AGENTS.md, no CLAUDE.md, no onboarding docs.
You have tools to explore: read files, run bash commands, grep, find, ls.

Your task: answer these questions by exploring the codebase. Use your tools.
- Read files to understand conventions, architecture, patterns
- Use grep/find to locate relevant code
- Be honest about what you can and cannot find

CRITICAL: Return a COMPLETE valid JSON array as your ONLY output. No explanation. No markdown. Just raw JSON.

[{"questionId":"iter0_q0","answered":true,"answer":"answer text","confidence":0.9,"evidence":["file1.ts"],"docsNeeded":null},{"questionId":"iter0_q1","answered":false,"answer":null,"confidence":0.2,"evidence":[],"failureReason":"couldn't find X","docsNeeded":"..."}]

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
  backend: RunnerBackend = "pi",
): Promise<QuestionResult[]> {
  const freshContext = freshAgentContext(info);

  const questionsText = questions
    .map((q) => `  - [${q.id}] (${q.category}, difficulty ${q.difficulty}) ${q.text}`)
    .join("\n");

  const prompt = TEST_AGENT_PROMPT
    .replace("{questions}", questionsText)
    .replace("{context}", freshContext);

  // Hide AGENTS.md / CLAUDE.md for the duration of the run by truncating
  // them to a placeholder and stashing real content in memory. Restore in
  // finally + signal handlers. Without this the agent's first move is to
  // read AGENTS.md and parrot it back, defeating the adversarial premise.
  const stashed = hideDocs(info.path);
  const restoreOnce = (() => {
    let restored = false;
    return () => { if (!restored) { restored = true; restoreDocs(stashed); } };
  })();
  const sigHandler = () => { restoreOnce(); process.exit(130); };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  let lastError: unknown;
  const maxRetries = 2;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const runner = new AgentRunner({
        cwd: info.path,
        model,
        thinkingLevel: "off",
        noContextFiles: true, // CRITICAL: strip AGENTS.md / CLAUDE.md
        maxTurns: 50,
        baseUrl,
        backend,
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
        // Tighten the "answered" criterion. The model is biased to report
        // answered: true even when it hedges. Treat as failed if:
        //   - confidence is below a real-knowledge threshold, OR
        //   - docsNeeded is populated (the model itself is telling us a
        //     doc is missing — that's literally a gap).
        const confidence = Math.min(1, Math.max(0, r.confidence || 0));
        const docsNeeded = r.docsNeeded || undefined;
        const modelClaimsAnswered = Boolean(r.answered);
        const reallyAnswered = modelClaimsAnswered && confidence >= 0.75 && !docsNeeded;
        results.push({
          questionId: r.questionId,
          answered: reallyAnswered,
          answer: r.answer || undefined,
          confidence,
          evidence: r.evidence || [],
          failureReason: r.failureReason || (reallyAnswered ? undefined : `low confidence (${confidence.toFixed(2)})${docsNeeded ? " + docs-needed" : ""}`),
          docsNeeded: docsNeeded || (reallyAnswered ? undefined : `Clarify: ${q.text}`),
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
  } finally {
    process.off("SIGINT", sigHandler);
    process.off("SIGTERM", sigHandler);
    restoreOnce();
  }
}
