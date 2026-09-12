/**
 * JSON Schema for the model's answer, handed to `claude --json-schema` so the
 * CLI enforces the shape itself. Kept deliberately simple (no tuples, no
 * optionals) for structured-output compatibility; zod does the final check.
 */
export const TOUR_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'sections'],
  properties: {
    title: { type: 'string', description: 'Short imperative title naming the change, like a good commit subject.' },
    summary: { type: 'string', description: '2 to 4 sentences describing the whole change and its motivation.' },
    sections: {
      type: 'array',
      description: 'Ordered sections of the tour, 2 to 8 of them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'files', 'excerpts'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: 'Why, then what, then what to watch. 2 to 5 sentences.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths this section is about, exactly as listed.' },
          excerpts: {
            type: 'array',
            description: '1 to 3 hunks that best show the idea.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['hunk', 'lines', 'note'],
              properties: {
                hunk: { type: 'string', description: 'A hunk id exactly as given in the diff, e.g. "F2.H1".' },
                lines: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'Empty for the whole hunk, or [start, end] new-file line numbers to narrow it.',
                },
                note: { type: 'string', description: 'Under 15 words: what to look at. May be empty.' },
              },
            },
          },
        },
      },
    },
  },
} as const;
