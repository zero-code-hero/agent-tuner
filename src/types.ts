export interface RepoInfo {
  path: string;
  language: string;
  packageManager: string;
  testFramework: string;
  linter: string;
  formatter: string;
  ciSystem: string;
  hasGit: boolean;
  topLanguages: string[];
  fileTypes: Record<string, number>;
  numFiles: number;
  numDirs: number;
  keyFiles: string[];
  existingAgentsMd: string;
  existingDocs: string[];
  commitPatterns: string[];
  importPatterns: string[];
  errorPatterns: string[];
  namingPatterns: string;
  projectStructure: string;
  configFiles: string[];
}

export interface DepthAnalysis {
  importPatterns: string[];
  errorPatterns: string[];
  codeStyle: string[];
  architecture: string[];
  antiPatterns: string[];
  envVars: string[];
  branching: string[];
  dependencies: string[];
  scripts: Record<string, string>;
  readmeContent: string;
}

export interface Rule {
  category: string;
  content: string;
  confidence: number;
  language?: string;
}

export interface ScoredRule {
  index: number;
  score: number;
  keep: boolean;
  reason: string;
  suggestion?: string;
  original: Rule;
}

export interface KeptRule {
  category: string;
  content: string;
  score: number;
  reason?: string;
}
