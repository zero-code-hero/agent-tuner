import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export const STATE_FILE = ".agent-tuner-state.json";

export interface Question {
  id: string;
  text: string;
  category: string;       // "setup", "testing", "conventions", "architecture", "gotchas"
  difficulty: number;     // 1-5, how hard for a fresh agent
  depth: number;          // which iteration this was generated at
}

export interface QuestionResult {
  questionId: string;
  answered: boolean;
  answer?: string;
  confidence: number;     // 0-1, how confident the fresh agent is
  evidence?: string[];    // files/patterns the agent found
  failureReason?: string; // why it failed
  docsNeeded?: string;    // what AGENTS.md should say
}

export interface IterationResult {
  iteration: number;
  depth: number;
  questionsGenerated: number;
  questionsAnswered: number;
  questionsFailed: number;
  gaps: Array<{ question: string; docsNeeded: string }>;
  scoreDelta: number;
}

export interface KeptRuleEntry {
  category: string;
  content: string;
  score: number;
  reason?: string;
}

export interface TunerState {
  repoPath: string;
  currentIteration: number;
  maxIterations: number;
  currentDepth: number;
  totalScore: number;
  previousScore: number;
  allQuestions: Question[];
  allResults: QuestionResult[];
  keptRules: KeptRuleEntry[];
  iterations: IterationResult[];
  plateauCount: number;
}

export function loadState(repoPath: string): TunerState | null {
  const statePath = join(repoPath, STATE_FILE);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as TunerState;
  } catch (e) {
    if (process.env.DEBUG) console.warn(`⚠️  Failed to parse state file: ${e}`);
    return null;
  }
}

export function saveState(repoPath: string, state: TunerState): void {
  const statePath = join(repoPath, STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function initState(repoPath: string, maxIterations: number): TunerState {
  return {
    repoPath,
    currentIteration: 0,
    maxIterations,
    currentDepth: 1,
    totalScore: 0,
    previousScore: 0,
    allQuestions: [],
    allResults: [],
    keptRules: [],
    iterations: [],
    plateauCount: 0,
  };
}

export function hasPlateaued(state: TunerState, threshold: number = 0.5): boolean {
  if (state.iterations.length < 2) return false;
  const delta = Math.abs(state.totalScore - state.previousScore);
  if (delta < threshold) {
    state.plateauCount++;
    return state.plateauCount >= 2;
  }
  state.plateauCount = 0;
  return false;
}
