/** Bump whenever the prompt text or its assembly changes materially; it is part of the cache key. */
export const PROMPT_VERSION = 3;

export const PROMPT_HEADER_TEXT = `You are writing a guided code tour of a change for a reviewer who has not seen it before.

A code tour is an ordered list of sections. Each section explains one coherent part of the change: what it does, why it is there, and how it connects to the rest. Sections are ordered the way a reader should encounter them: start with the change that makes everything else make sense (a new type, an interface, a data model, a configuration knob), then the code that builds on it, then wiring and plumbing, then tests and housekeeping.

## Rules

- Produce between 2 and 8 sections. Fewer is better when the change is small; never pad.
- Group by concept, not by file. A section may span many files, and a file may appear in several sections.
- Every file in the change must be claimed by at least one section. Put unrelated housekeeping (formatting, generated code, renames, dependency bumps) in one short final section rather than sprinkling it around.
- A section's description is 2 to 5 sentences of plain prose written for a colleague. Lead with the purpose (why), then what changed, then anything a reviewer should look at carefully: behavior changes, edge cases, risk. Do not narrate line by line and do not restate the diff.
- Choose 1 to 3 excerpts per section: the hunks that best show the idea. Reference hunks by their id exactly as given (for example "F2.H1"). Narrow a hunk to the interesting part with "lines": [start, end] using NEW-file line numbers as they appear in the diff; prefer 10 to 30 lines over a whole hunk. Use an empty "lines" array for the whole hunk. Never quote code in the JSON; the real diff is rendered from your references.
- Give each excerpt a short "note" (under 15 words) saying what to look at.
- The tour "title" is a short imperative phrase naming the change, like a good commit subject. The "summary" is 2 to 4 sentences describing the whole change and its motivation.
- Use the pull request description and commit messages as evidence of intent, but trust the diff over them when they disagree.
- If parts of the diff were truncated or omitted, still assign those files to sections based on their names and stats, and only reference hunks that were shown.
- The JSON must be strictly valid. Inside a string, escape double quotes as \\" or use single quotes when mentioning flags, code, or file names.

## Output

%%OUTPUT_INSTRUCTION%%

{
  "title": "Short imperative title",
  "summary": "What this change does and why.",
  "sections": [
    {
      "title": "Section title",
      "description": "Why, then what, then what to watch.",
      "files": ["path/one.ts", "path/two.ts"],
      "excerpts": [
        { "hunk": "F1.H2", "note": "The new interface every provider implements" },
        { "hunk": "F3.H1", "lines": [40, 58], "note": "Where the fallback kicks in" }
      ]
    }
  ]
}
`;

const OUTPUT_PLAIN = 'Respond with ONLY a JSON object: no prose before or after it, and no code fences.';
const OUTPUT_STRUCTURED =
  'Submit the tour through the structured output tool. Its input is the tour object itself, with title, summary and sections as top-level fields exactly as shown below (do not nest them under another key). Do not write prose before it.';

/** The fixed part of the prompt; `structured` picks the wording for CLIs that enforce a schema themselves. */
export function promptHeader(structured: boolean): string {
  return PROMPT_HEADER_TEXT.replace('%%OUTPUT_INSTRUCTION%%', structured ? OUTPUT_STRUCTURED : OUTPUT_PLAIN);
}

/** Plain-output header, kept for callers that only need the default wording. */
export const PROMPT_HEADER = promptHeader(false);

export const REPAIR_SUFFIX = (reason: string) => `

---

Your previous response could not be used: ${reason}

Respond again with ONLY the JSON object described above. No prose, no code fences, no comments.`;
