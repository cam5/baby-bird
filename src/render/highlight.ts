import { common, createLowlight } from 'lowlight';
import type pc from 'picocolors';

type Colors = ReturnType<typeof pc.createColors>;
type Styler = (s: string) => string;

const lowlight = createLowlight(common);

/** Map file extensions / names to highlight.js language ids (only those in lowlight's `common` set). */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', dart: 'dart',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff',
  makefile: 'makefile', mk: 'makefile',
  vb: 'vbnet', vbnet: 'vbnet', wasm: 'wasm',
};

const BY_NAME: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'bash', rakefile: 'ruby', gemfile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', 'cmakelists.txt': 'cmake',
};

export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = BY_NAME[base];
  if (byName && lowlight.registered(byName)) return byName;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return null;
  const lang = BY_EXT[base.slice(dot + 1)];
  return lang && lowlight.registered(lang) ? lang : null;
}

/** highlight.js scope -> style. Deliberately avoids green/red so add/del stays unambiguous. */
function stylers(c: Colors): Record<string, Styler> {
  return {
    keyword: c.magenta, 'selector-tag': c.magenta, 'template-tag': c.magenta, doctag: c.magenta,
    string: c.yellow, regexp: c.yellow, 'template-variable': c.yellow, subst: (s) => s,
    comment: c.gray, quote: c.gray,
    number: c.cyan, literal: c.cyan, symbol: c.cyan, bullet: c.cyan, link: c.cyan,
    title: c.blue, section: c.blue, 'selector-id': c.blue, 'selector-class': c.blue,
    type: c.cyan, built_in: c.cyan, class: c.cyan,
    attr: c.blue, attribute: c.blue, property: c.blue, variable: (s) => s, params: (s) => s,
    meta: c.gray, tag: c.blue, name: c.blue, 'selector-attr': c.blue, 'selector-pseudo': c.blue,
    addition: (s) => s, deletion: (s) => s, emphasis: c.italic, strong: c.bold,
  };
}

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
  properties?: { className?: string[] };
}

/**
 * Highlight `code` and return one ANSI-styled string per input line. Tokens
 * that span lines (block comments, template strings) are styled on every line.
 */
export function highlightCode(code: string, lang: string, c: Colors): string[] | null {
  if (!lowlight.registered(lang)) return null;
  let tree: HastNode;
  try {
    tree = lowlight.highlight(lang, code) as unknown as HastNode;
  } catch {
    return null;
  }
  const map = stylers(c);
  const lines: string[] = [''];

  const visit = (node: HastNode, style: Styler | null): void => {
    if (node.type === 'text' && typeof node.value === 'string') {
      const parts = node.value.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) lines.push('');
        if (part) lines[lines.length - 1] += style ? style(part) : part;
      });
      return;
    }
    let own = style;
    for (const cls of node.properties?.className ?? []) {
      const scope = cls.startsWith('hljs-') ? cls.slice(5) : cls;
      const s = map[scope];
      if (s) {
        own = s;
        break;
      }
    }
    for (const child of node.children ?? []) visit(child, own);
  };
  visit(tree, null);

  const expected = code.split('\n').length;
  if (lines.length !== expected) return null; // defensive: never let a grammar quirk misalign the gutter
  return lines;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** Restore default foreground and intensity/italic/underline, but leave any background in place. */
const SOFT_RESET = '\x1b[39m\x1b[22m\x1b[23m\x1b[24m';

/** Cut a styled string to `max` visible characters, keeping escape codes intact. */
export function truncateAnsi(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  let out = '';
  let seen = 0;
  const limit = Math.max(0, max - 1);
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (seen >= limit) break;
    out += s[i];
    seen++;
    i++;
  }
  return out + SOFT_RESET + '…';
}

