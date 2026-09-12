import type { DiffFile, FileStatus, Hunk, HunkLine, ParsedDiff } from '../core/types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of unusual paths ("a/we ird\tname"). */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  return inner.replace(/\\([abfnrtv\\"]|[0-7]{3})/g, (_, esc: string) => {
    switch (esc) {
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case '\\': return '\\';
      case '"': return '"';
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  const p = unquote(path);
  return p.startsWith(prefix) ? p.slice(2) : p;
}

/** Best-effort split of the "a/X b/Y" part of a `diff --git` line. */
function splitGitHeader(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    // Quoted form: "a/x" "b/y"
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (m) return { oldPath: stripPrefix(m[1]!, 'a/'), newPath: stripPrefix(m[2]!, 'b/') };
  }
  // Prefer a split where both sides are identical (the common, unrenamed case).
  let idx = rest.indexOf(' b/');
  while (idx !== -1) {
    const left = rest.slice(0, idx);
    const right = rest.slice(idx + 1);
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return { oldPath: left.slice(2), newPath: right.slice(2) };
    }
    idx = rest.indexOf(' b/', idx + 1);
  }
  const first = rest.indexOf(' b/');
  if (first === -1) return { oldPath: rest, newPath: rest };
  return { oldPath: stripPrefix(rest.slice(0, first), 'a/'), newPath: stripPrefix(rest.slice(first + 1), 'b/') };
}

interface PendingFile {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

/**
 * Parse `git diff` output (with a/ b/ prefixes) into files, hunks and numbered lines.
 * Tolerant of mode-only changes, pure renames, binary files and "\ No newline" markers.
 */
export function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n');
  const files: DiffFile[] = [];
  let pending: PendingFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (!pending) return;
    const id = `F${files.length + 1}`;
    let additions = 0;
    let deletions = 0;
    pending.hunks.forEach((h, i) => {
      h.id = `${id}.H${i + 1}`;
      for (const l of h.lines) {
        if (l.type === 'add') additions++;
        else if (l.type === 'del') deletions++;
      }
    });
    const status = pending.status;
    const path = status === 'deleted' ? pending.oldPath : pending.newPath;
    const file: DiffFile = {
      id,
      path,
      status,
      binary: pending.binary,
      additions,
      deletions,
      hunks: pending.hunks,
    };
    if (status === 'renamed') file.oldPath = pending.oldPath;
    files.push(file);
    pending = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      flush();
      const { oldPath, newPath } = splitGitHeader(line.slice('diff --git '.length));
      pending = { oldPath, newPath, status: 'modified', binary: false, hunks: [] };
      continue;
    }
    if (!pending) continue;

    if (hunk) {
      const c = line[0];
      if (c === ' ' || c === '+' || c === '-' || (line === '' && i < lines.length - 1 && hunkHasRoom(hunk))) {
        const text = line.slice(1);
        const entry: HunkLine = c === '+' ? { type: 'add', newNo: newNo++, text }
          : c === '-' ? { type: 'del', oldNo: oldNo++, text }
          : { type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: c === undefined ? '' : text };
        hunk.lines.push(entry);
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      hunk = null; // fall through: this line belongs to the file header of the next section
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      hunk = {
        id: '',
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: (hm[5] ?? '').trim(),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      pending.hunks.push(hunk);
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p === '/dev/null') pending.status = 'added';
      else pending.oldPath = stripPrefix(p, 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p === '/dev/null') pending.status = 'deleted';
      else pending.newPath = stripPrefix(p, 'b/');
      continue;
    }
    if (line.startsWith('rename from ')) {
      pending.oldPath = unquote(line.slice('rename from '.length));
      pending.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      pending.newPath = unquote(line.slice('rename to '.length));
      pending.status = 'renamed';
      continue;
    }
    if (line.startsWith('new file mode')) {
      pending.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      pending.status = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      pending.binary = true;
      continue;
    }
    // index, similarity, old/new mode, copy from/to: ignored
  }
  flush();
  return { files };
}

function hunkHasRoom(h: Hunk): boolean {
  // An empty line inside a hunk (a context line whose content is empty and whose
  // leading space was stripped by some tool) only counts while the hunk is incomplete.
  let o = 0;
  let n = 0;
  for (const l of h.lines) {
    if (l.type !== 'add') o++;
    if (l.type !== 'del') n++;
  }
  return o < h.oldLines || n < h.newLines;
}

export function diffStats(diff: ParsedDiff): { files: number; additions: number; deletions: number } {
  return diff.files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}
