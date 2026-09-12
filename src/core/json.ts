import { BadLlmOutputError } from './errors.js';

/**
 * Pull a JSON object out of model output that may be wrapped in prose, code
 * fences, or a CLI's own JSON envelope (e.g. `claude --output-format json`).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new BadLlmOutputError('The model returned empty output.', text);

  const candidates: string[] = [trimmed];
  for (const m of trimmed.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  const balanced = firstBalancedObject(trimmed);
  if (balanced) candidates.push(balanced);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed === undefined) continue;
    return unwrapEnvelope(parsed);
  }
  throw new BadLlmOutputError('Could not find a JSON object in the model output.', text, 'Run with --debug to see the raw output.');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** If the object looks like a CLI envelope ({ result: "..." }) rather than a tour, dig into it. */
function unwrapEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if ('sections' in obj) return obj;
  for (const key of ['result', 'response', 'content', 'text', 'output']) {
    const inner = obj[key];
    if (typeof inner === 'string' && inner.includes('{')) {
      try {
        return extractJson(inner);
      } catch {
        // keep looking
      }
    }
    if (typeof inner === 'object' && inner !== null) return unwrapEnvelope(inner);
  }
  return obj;
}

function firstBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
