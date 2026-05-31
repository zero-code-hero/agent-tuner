import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { TOOL_SIGNATURES } from "./constants.js";

export function detectTooling(path: string): {
  configFiles: string[];
  packageManager: string;
  testFramework: string;
  linter: string;
  formatter: string;
  ciSystem: string;
  buildTools: string[];
  agentDoc: string;
} {
  const result = {
    configFiles: [] as string[],
    packageManager: "",
    testFramework: "",
    linter: "",
    formatter: "",
    ciSystem: "",
    buildTools: [] as string[],
    agentDoc: "",
  };

  const githubWorkflows = join(path, ".github", "workflows");
  if (existsSync(githubWorkflows)) {
    result.ciSystem = "github actions";
    result.configFiles.push(".github/workflows");
  }

  for (const [filename, sig] of Object.entries(TOOL_SIGNATURES)) {
    if (!existsSync(join(path, filename))) continue;
    result.configFiles.push(filename);
    switch (sig.type) {
      case "packageManager": if (!result.packageManager) result.packageManager = sig.value; break;
      case "testFramework": if (!result.testFramework) result.testFramework = sig.value; break;
      case "linter": if (!result.linter) result.linter = sig.value; break;
      case "formatter": if (!result.formatter) result.formatter = sig.value; break;
      case "ciSystem": if (!result.ciSystem) result.ciSystem = sig.value; break;
      case "buildTool": result.buildTools.push(sig.value); break;
      case "agentDoc": if (!result.agentDoc) result.agentDoc = sig.value; break;
    }
  }

  return result;
}

export function readAgentDoc(path: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const fullPath = join(path, name);
    if (existsSync(fullPath)) {
      try { return readFileSync(fullPath, "utf-8"); } catch (e: any) {
        if (process.env.DEBUG) console.warn(`⚠️  Could not read ${name}: ${e.message}`);
      }
    }
  }
  return "";
}

export function extractScripts(path: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8"));
    return pkg.scripts || {};
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not extract scripts from package.json: ${e.message}`);
    return {};
  }
}
