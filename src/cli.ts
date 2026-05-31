#!/usr/bin/env node
import { resolve } from "path";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { program } from "commander";
import { discoverAtDepth, clearCaches } from "./context_builder.js";
import { generateRulesFromGaps } from "./generate.js";
import { scoreRules, filterRules, consolidate } from "./llm_score.js";
import { generateQuestions } from "./questions.js";
import { testFreshAgent } from "./test_agent.js";
import { initState, loadState, saveState, hasPlateaued } from "./state.js";
import type { TunerState, IterationResult, KeptRuleEntry } from "./state.js";
import type { RepoInfo } from "./types.js";

program
  .name("agent-tuner")
  .description("Generate optimized AGENTS.md via adversarial self-improvement loop")
  .argument("<repo>", "Path to the repository")
  .option("-o, --output <path>", "Output file path", "AGENTS.md")
  .option("-m, --model <model>", "LLM model", "anthropic/claude-sonnet-4-5-20250929")
  .option("-t, --threshold <n>", "Minimum score to keep a rule (1-10)", "6")
  .option("-n, --iterations <n>", "Max iterations", "5")
  .option("--dry-run", "Print output without writing file")
  .option("--merge", "Merge with existing AGENTS.md")
  .option("-b, --base-url <url>", "Custom OpenAI-compatible API base URL")
  .option("-v, --verbose", "Show details")

  .option("--resume", "Resume from saved state")
  .action(async (repo: string, opts) => {
    const path = resolve(repo);
    const outputPath = resolve(opts.output);

    console.log(`🔍 Scanning ${path}\n`);

    // API key check — provider-aware (like SIA's OpenHands backend)
    const [provider] = opts.model.split("/");
    const needsKey = !opts.baseUrl;
    let apiKey: string | undefined;
    if (provider === "anthropic" || opts.model.toLowerCase().includes("claude")) {
      apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (provider === "google" || opts.model.toLowerCase().includes("gemini")) {
      apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    } else {
      apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    }
    if (needsKey && !apiKey) {
      console.log(`❌ No API key for model ${opts.model}. Set one of:`);
      console.log("   export ANTHROPIC_API_KEY='...'   (for anthropic/* models)");
      console.log("   export OPENAI_API_KEY='...'      (for openai/* models)");
      console.log("   export LLM_API_KEY='...'         (for custom endpoints)");
      console.log("   Or use --base-url for a local endpoint");
      process.exit(1);
    }

    // Load or init state
    const existingState = loadState(path);
    let state: TunerState;

    if (opts.resume && existingState) {
      state = existingState;
      console.log(`📂 Resuming from iteration ${state.currentIteration + 1}\n`);
    } else if (existingState && !opts.resume) {
      // Refuse to run with stale state — force explicit choice
      console.log(`❌ Existing state found at ${path}/.agent-tuner-state.json`);
      console.log(`   Use --resume to continue, or delete the file to start fresh.`);
      process.exit(1);
    } else {
      clearCaches();
      state = initState(path, parseInt(opts.iterations, 10));
    }

    // ─── Loop mode ───
    let finalOutput = "";
    const maxIterations = parseInt(opts.iterations, 10);

    for (let iter = state.currentIteration; iter < maxIterations; iter++) {
      state.currentIteration = iter;
      state.currentDepth = Math.min(iter + 1, 4);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`  Iteration ${iter + 1} (depth ${state.currentDepth})`);
      console.log(`${"═".repeat(50)}\n`);

      // Discover at current depth
      const { info, depthAnalysis } = discoverAtDepth(path, state.currentDepth, state);
      if (iter === 0) printDiscovery(info);

      // Step 1: Generate questions
      console.log(`📝 Generating questions...`);
      const questions = await generateQuestions(info, depthAnalysis, state, opts.model, opts.baseUrl);
      console.log(`   ${questions.length} questions`);

      if (questions.length === 0) {
        console.log("   No questions generated. Stopping.");
        break;
      }

      if (opts.verbose) {
        for (const q of questions) {
          console.log(`   [${q.category}] ${q.text}`);
        }
      }

      // Step 2: Fresh agent tries to answer
      console.log(`\n🧪 Fresh agent (no AGENTS.md) attempts answers...`);
      const results = await testFreshAgent(info, depthAnalysis, state, questions, opts.model, opts.baseUrl);

      const answered = results.filter((r) => r.answered);
      const failed = results.filter((r) => !r.answered);
      console.log(`   ✅ ${answered.length} answered   ❌ ${failed.length} failed`);

      if (opts.verbose) {
        for (const r of results) {
          const status = r.answered ? "✅" : "❌";
          const preview = r.answered ? (r.answer?.slice(0, 70) || "") : (r.failureReason?.slice(0, 70) || "");
          console.log(`   ${status} [${r.confidence.toFixed(2)}] ${preview}`);
          if (r.docsNeeded) console.log(`      → ${r.docsNeeded.slice(0, 90)}`);
        }
      }

      // Step 3: Generate rules from gaps
      const gaps = failed.map((r) => ({
        question: r.questionId,
        docsNeeded: r.docsNeeded || questions.find((q) => q.id === r.questionId)?.text || "unknown",
      }));

      if (gaps.length > 0) {
        const newRules = await generateRulesFromGaps(info, depthAnalysis, gaps, state, opts.model, opts.baseUrl);
        console.log(`\n🧠 Scoring ${newRules.length} gap-filling rules...`);
        const scored = await scoreRules(info, depthAnalysis, newRules, state, opts.model, opts.verbose, opts.baseUrl, parseFloat(opts.threshold));
        const kept = filterRules(scored, parseFloat(opts.threshold));

        const newEntries: KeptRuleEntry[] = kept.map((k) => ({
          category: k.category,
          content: k.content,
          score: k.score,
          reason: k.reason,
        }));
        state.keptRules.push(...newEntries);
        console.log(`   Kept ${kept.length} rules`);
      }

      // Update state
      state.allQuestions.push(...questions);
      state.allResults.push(...results);

      const currentScore = state.keptRules.reduce((sum, k) => sum + k.score, 0);
      state.previousScore = state.totalScore;
      state.totalScore = currentScore;

      const iterResult: IterationResult = {
        iteration: iter + 1,
        depth: state.currentDepth,
        questionsGenerated: questions.length,
        questionsAnswered: answered.length,
        questionsFailed: failed.length,
        gaps,
        scoreDelta: currentScore - state.previousScore,
      };
      state.iterations.push(iterResult);

      const delta = currentScore - state.previousScore;
      console.log(`\n   Score: ${state.totalScore} (delta: ${delta > 0 ? "+" : ""}${delta})`);

      // Save state for resume
      saveState(path, state);

      // Check plateau
      if (hasPlateaued(state, 1)) {
        console.log(`\n⚡ Score plateaued. Stopping.`);
        break;
      }
    }

    // Final output
    finalOutput = consolidate(state.keptRules);

    if (opts.merge) {
      // Re-read current AGENTS.md for merge
      try {
        const existing = readFileSync(resolve(path, "AGENTS.md"), "utf-8");
        const cleaned = existing.includes("Auto-generated by agent-tuner")
          ? existing.split("Auto-generated by agent-tuner")[0].trimEnd()
          : existing;
        finalOutput = cleaned + "\n\n" + finalOutput;
      } catch { /* no existing file */ }
    }

    // Summary
    console.log(`\n${"═".repeat(50)}`);
    console.log(`  Summary`);
    console.log(`${"═".repeat(50)}`);
    console.log(`  Iterations:   ${state.iterations.length}`);
    console.log(`  Questions:    ${state.allQuestions.length}`);
    console.log(`  Failed:       ${state.allResults.filter((r) => !r.answered).length}`);
    console.log(`  Rules kept:   ${state.keptRules.length}`);
    console.log(`  Total score:  ${state.totalScore}`);

    outputResult(finalOutput, outputPath, opts.dryRun);
  });

program.parse();

function printDiscovery(info: RepoInfo) {
  console.log(`   Language: ${info.topLanguages.join(", ") || "unknown"}`);
  console.log(`   Files: ${info.numFiles}, Dirs: ${info.numDirs}`);
  if (info.packageManager) console.log(`   Package manager: ${info.packageManager}`);
  if (info.testFramework) console.log(`   Tests: ${info.testFramework}`);
  if (info.linter) console.log(`   Linter: ${info.linter}`);
  if (info.ciSystem) console.log(`   CI: ${info.ciSystem}`);
  console.log("");
}

function outputResult(result: string, outputPath: string, dryRun: boolean) {
  if (dryRun) {
    console.log("\n--- DRY RUN ---");
    console.log(result);
    console.log("--- END DRY RUN ---");
  } else {
    writeFileSync(outputPath, result);
    const lines = result.split("\n").length;
    console.log(`\n💾 Written to ${outputPath}`);
    console.log(`   ${lines} lines, ${result.length} chars`);
  }
}