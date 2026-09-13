import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { highlightCode, languageForPath, stripAnsi, truncateAnsi } from '../../src/render/highlight.js';

const c = pc.createColors(true);

describe('languageForPath', () => {
  it('maps extensions and special names', () => {
    expect(languageForPath('src/a/b.ts')).toBe('typescript');
    expect(languageForPath('x.tsx')).toBe('typescript');
    expect(languageForPath('lib/foo.py')).toBe('python');
    expect(languageForPath('Makefile')).toBe('makefile');
    expect(languageForPath('Dockerfile')).toBe('bash');
    expect(languageForPath('config.yml')).toBe('yaml');
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('weird.unknownext')).toBeNull();
    expect(languageForPath('LICENSE')).toBeNull();
  });
});

describe('highlightCode', () => {
  it('returns one styled line per input line with the same visible text', () => {
    const code = ['/* a comment', '   that spans */', "const x: number = 'hi'; // trailing", '', 'export function f() { return 42; }'].join('\n');
    const lines = highlightCode(code, 'typescript', c)!;
    expect(lines).toHaveLength(5);
    expect(lines.map(stripAnsi)).toEqual(code.split('\n'));
    // multi-line comment is styled on both of its lines
    expect(lines[0]).toContain('\x1b[90m');
    expect(lines[1]).toContain('\x1b[90m');
    // keyword and string get distinct styles
    expect(lines[2]).toContain('\x1b[35mconst');
    expect(lines[2]).toContain("\x1b[33m'hi'");
    expect(lines[3]).toBe('');
  });

  it('never uses green or red foreground, which are reserved for add/del', () => {
    const code = "import { a } from './a';\nconst s = `t ${a}`;\nif (a > 1) { return null; }";
    const out = highlightCode(code, 'javascript', c)!.join('\n');
    expect(out).not.toContain('\x1b[32m');
    expect(out).not.toContain('\x1b[31m');
  });

  it('returns null for unknown languages', () => {
    expect(highlightCode('x', 'not-a-language', c)).toBeNull();
  });

  it('is a no-op when colors are disabled', () => {
    const lines = highlightCode('const a = 1;', 'typescript', pc.createColors(false))!;
    expect(lines).toEqual(['const a = 1;']);
  });
});

describe('truncateAnsi', () => {
  it('cuts by visible width, keeps escapes, and soft-resets before the ellipsis', () => {
    const s = `${c.magenta('const')} ${c.yellow('"a long string"')} more`;
    expect(truncateAnsi(s, 100)).toBe(s);
    const cut = truncateAnsi(s, 10);
    expect(stripAnsi(cut)).toBe('const "a …');
    expect(cut).toContain('\x1b[35mconst');
    expect(cut.endsWith('\x1b[39m\x1b[22m\x1b[23m\x1b[24m…')).toBe(true);
  });
});
