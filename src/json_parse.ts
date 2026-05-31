// Unified JSON extraction. Handles raw JSON, markdown fences, and embedded
// objects/arrays. Try direct parse first to avoid losing non-fenced output.
function extractJson(text: string): string | null {
  let cleaned = text.trim();

  // Try direct parse first — if it's already valid JSON, use it as-is.
  try { JSON.parse(cleaned); return cleaned; } catch {}

  // Strip markdown code fences. Take the last fenced block (LLMs often put
  // the final answer in the last fence). Use balanced ``` regex to handle
  // nested code examples that produce odd fence counts.
  if (cleaned.includes("```")) {
    const fenceRegex = /```(?:\w*)\n?([\s\S]*?)```/g;
    let lastMatch: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(cleaned)) !== null) {
      lastMatch = m[1];
    }
    if (lastMatch !== null) {
      cleaned = lastMatch.trim();
      // Remove leading language tag like "json\n"
      cleaned = cleaned.replace(/^(json|txt|text|md)\n/, "");
      try { JSON.parse(cleaned); return cleaned; } catch {}
    }
  }

  // Try to find a JSON array in the text
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { JSON.parse(arrMatch[0]); return arrMatch[0]; } catch {}
  }

  // Try to find a JSON object in the text
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { JSON.parse(objMatch[0]); return objMatch[0]; } catch {}
  }

  return null;
}

export function tryParseJsonArray(text: string): Array<any> | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function tryParseJsonObject<T = any>(text: string, fallback: T): T {
  const json = extractJson(text);
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
