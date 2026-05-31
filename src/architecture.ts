import { readdirSync, readFileSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { execSync } from "child_process";
import { SKIP_DIRS } from "./constants.js";

const EXT_MAP: Record<string, string[]> = {
  typescript: [".ts", ".tsx"], javascript: [".js", ".jsx"],
  python: [".py"], rust: [".rs"], go: [".go"],
};

const ARCH_DIRS = new Set([
  "controllers", "models", "views", "services", "repositories",
  "handlers", "middlewares", "middleware", "routes", "api",
  "lib", "utils", "helpers", "types", "interfaces",
  "components", "hooks", "providers", "store", "stores",
]);

// ─── Depth 2+ ───

export function getCommitPatterns(path: string): string[] {
  try {
    const output = execSync("git log --oneline -30", { cwd: path, encoding: "utf-8", stdio: "pipe" });
    const prefixes = new Set<string>();
    for (const line of output.trim().split("\n").slice(0, 20)) {
      const parts = line.split(" ", 2);
      if (parts.length > 1) {
        const msg = parts[1]?.trim();
        if (msg) {
          const firstWord = msg.split(/[\s:]/)[0];
          if (firstWord && firstWord.length < 20) prefixes.add(firstWord);
        }
      }
    }
    return Array.from(prefixes).slice(0, 10);
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not read git log: ${e.message}`);
    return [];
  }
}

// ─── Depth 3+ ───

export function analyzeArchitecture(path: string, languages: string[], allFiles: string[]): string[] {
  const findings: string[] = [];

  // Monorepo
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8"));
    if (Array.isArray(pkg.workspaces)) {
      findings.push(`Monorepo with workspaces: ${pkg.workspaces.join(", ")}`);
    }
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not read package.json for monorepo detection: ${e.message}`);
  }

  // Module boundaries
  for (const lang of languages.slice(0, 2)) {
    const exts = EXT_MAP[lang] || [];
    const modules = new Set<string>();
    for (const file of allFiles) {
      if (!exts.some((e) => file.endsWith(e))) continue;
      if (file.split("/").some((p) => SKIP_DIRS.has(p))) continue;
      const parts = file.split("/");
      if (parts.length >= 2) modules.add(parts[0]);
    }
    if (modules.size > 2) {
      findings.push(`${lang} has ${modules.size} top-level modules: ${Array.from(modules).slice(0, 8).join(", ")}`);
    }
  }

  // Architecture patterns
  const dirNames = new Set<string>();
  for (const file of allFiles) {
    for (const p of file.split("/")) {
      if (ARCH_DIRS.has(p.toLowerCase())) {
        dirNames.add(p.toLowerCase());
      }
    }
  }
  if (dirNames.size >= 3) {
    findings.push(`Architecture patterns: ${Array.from(dirNames).join(", ")}`);
  }

  return findings;
}

export function detectEnvVars(path: string): string[] {
  const findings: string[] = [];
  for (const name of [".env", ".env.example", ".env.sample", ".env.template"]) {
    if (existsSync(join(path, name))) {
      try {
        const content = readFileSync(join(path, name), "utf-8");
        const vars = content.split("\n")
          .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
          .map((l) => l.split("=")[0].trim())
          .filter(Boolean);
        if (vars.length > 0) findings.push(`${name} defines: ${vars.slice(0, 10).join(", ")}`);
      } catch (e: any) {
        if (process.env.DEBUG) console.warn(`⚠️  Could not read ${name}: ${e.message}`);
      }
    }
  }
  for (const name of ["docker-compose.yml", "docker-compose.yaml"]) {
    if (existsSync(join(path, name))) findings.push(`${name} present`);
  }
  return findings;
}

export function inferNaming(path: string): string {
  const parts: string[] = [];
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    const files = entries.filter((e) => e.isFile() && extname(e.name)).map((e) => e.name);
    if (dirs.length > 0) {
      const snake = dirs.filter((d) => d.includes("_") && d === d.toLowerCase()).length;
      const kebab = dirs.filter((d) => d.includes("-") && d === d.toLowerCase()).length;
      const camel = dirs.filter((d) => d[0]?.toLowerCase() === d[0] && /[A-Z]/.test(d.slice(1))).length;
      const max = Math.max(snake, kebab, camel);
      if (max > dirs.length * 0.3) {
        const style = snake >= max ? "snake_case" : kebab >= max ? "kebab-case" : "camelCase";
        parts.push(`Directories use ${style}`);
      }
    }
    if (files.length > 0) {
      const snake = files.filter((f) => extname(f) && basename(f, extname(f)).includes("_")).length;
      const kebab = files.filter((f) => extname(f) && basename(f, extname(f)).includes("-")).length;
      if (snake > files.length * 0.3) parts.push("Files use snake_case");
      else if (kebab > files.length * 0.3) parts.push("Files use kebab-case");
    }
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not infer naming conventions: ${e.message}`);
  }
  return parts.join("; ") || "No strong naming convention detected";
}

// ─── Depth 4+ ───

export function detectBranchingStrategy(path: string): string[] {
  const findings: string[] = [];
  try {
    const output = execSync("git branch -r --sort=-committerdate", { cwd: path, encoding: "utf-8", stdio: "pipe" });
    const branches = output.trim().split("\n").map((l) => l.trim().replace("origin/", "")).filter(Boolean);
    const types = { main: 0, develop: 0, feature: 0, bugfix: 0, hotfix: 0, release: 0 };
    for (const b of branches) {
      if (b === "main" || b === "master") types.main++;
      else if (b === "develop") types.develop++;
      else if (b.startsWith("feature/") || b.startsWith("feat/")) types.feature++;
      else if (b.startsWith("bugfix/") || b.startsWith("fix/")) types.bugfix++;
      else if (b.startsWith("hotfix/")) types.hotfix++;
      else if (b.startsWith("release/")) types.release++;
    }
    const active = Object.entries(types).filter(([, c]) => c > 0).map(([k]) => k);
    if (active.length > 1) findings.push(`Branching: ${active.join(", ")} branches`);
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not detect branching strategy: ${e.message}`);
  }
  return findings;
}

export function analyzeDependencies(path: string, languages: string[]): string[] {
  const findings: string[] = [];
  if (languages.includes("typescript") || languages.includes("javascript")) {
    try {
      const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8"));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      findings.push(`${languages[0]}: ${deps.length} runtime deps, ${devDeps.length} dev deps`);
      if (deps.length > 0) findings.push(`Key deps: ${deps.slice(0, 8).join(", ")}`);
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not analyze JS/TS dependencies: ${e.message}`);
    }
  }
  if (languages.includes("python")) {
    for (const name of ["requirements.txt", "pyproject.toml"]) {
      if (existsSync(join(path, name))) {
        try {
          const content = readFileSync(join(path, name), "utf-8");
          const deps = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
          findings.push(`Python: ~${deps} deps in ${name}`);
        } catch (e: any) {
          if (process.env.DEBUG) console.warn(`⚠️  Could not read ${name}: ${e.message}`);
        }
      }
    }
  }
  if (languages.includes("rust")) {
    try {
      const content = readFileSync(join(path, "Cargo.toml"), "utf-8");
      const deps = content.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).length;
      findings.push(`Rust: ~${deps} deps`);
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read Cargo.toml: ${e.message}`);
    }
  }
  return findings;
}
