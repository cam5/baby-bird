import { z } from 'zod';

/** What the model must return. Excerpts are references into the diff we sent. */
export const LlmExcerptRefSchema = z.object({
  hunk: z.string().min(1),
  /** Optional [start, end] new-file line numbers to narrow the hunk; fewer than two numbers means the whole hunk. */
  lines: z.array(z.number().int().nonnegative()).optional(),
  note: z.string().optional(),
});

export const LlmSectionSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  files: z.array(z.string()).optional(),
  excerpts: z.array(LlmExcerptRefSchema).optional(),
});

export const LlmTourOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  sections: z.array(LlmSectionSchema).min(1),
});

export type LlmTourOutput = z.infer<typeof LlmTourOutputSchema>;
export type LlmSection = z.infer<typeof LlmSectionSchema>;
export type LlmExcerptRef = z.infer<typeof LlmExcerptRefSchema>;

/** Persisted Tour, validated when read back from the cache. */
const HunkLineSchema = z.object({
  type: z.enum(['add', 'del', 'ctx']),
  oldNo: z.number().int().optional(),
  newNo: z.number().int().optional(),
  text: z.string(),
});

const StatsSchema = z.object({
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});

const TourSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('range'),
    base: z.string(),
    head: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    mergeBase: z.string().optional(),
    resolvedBy: z.enum(['explicit', 'pull-request', 'ancestor-branch', 'default-branch']),
  }),
  z.object({
    kind: z.literal('working'),
    headSha: z.string(),
    staged: z.boolean(),
    resolvedBy: z.enum(['explicit', 'dirty-tree']),
  }),
]);

export const TourSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  source: TourSourceSchema,
  generator: z.object({ preset: z.string().nullable(), command: z.array(z.string()) }),
  pullRequest: z.object({ number: z.number().int(), title: z.string(), url: z.string() }).optional(),
  title: z.string(),
  summary: z.string(),
  stats: StatsSchema,
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      stats: StatsSchema,
      excerpts: z.array(
        z.object({
          file: z.string(),
          hunkId: z.string(),
          note: z.string().optional(),
          oldStart: z.number().int(),
          newStart: z.number().int(),
          lines: z.array(HunkLineSchema),
        }),
      ),
    }),
  ),
});

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
