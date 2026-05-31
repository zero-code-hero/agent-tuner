export function tryParseJsonArray(text: string): Array<any> | null {
  let cleaned = text;
  if (cleaned.startsWith("```")) {
    const inner = cleaned.split("```");
    cleaned = inner.length >= 3 ? inner[1] : inner[2] || cleaned;
    if (cleaned.match(/^(json|txt|text)\n/)) {
      cleaned = cleaned.replace(/^(json|txt|text)\n/, "");
    }
  }
  cleaned = cleaned.trim();
  const bracketMatch = cleaned.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}
