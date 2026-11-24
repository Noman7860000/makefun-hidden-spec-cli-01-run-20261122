// mend — one patch tool for every AI edit format.
//
// Applies unified diffs, search/replace blocks, v4a patches and JSON edit
// lists to a working tree, with a strict all-or-nothing write rule.
//
// Usage:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   PATCH is a file path, or "-" / omitted to read the patch from stdin.
//
// Exit codes: 0 success, 1 one or more edits failed, 2 usage / no patch /
// format error / parse error. Error lines are the only output on exit 2.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- errors

class Fail extends Error {
  code: string;
  constructor(code: string, path?: string) {
    super(path === undefined ? code : `${code} ${path}`);
    this.code = code;
  }
}

class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------- paths

// A path is safe when it is non-empty, does not start with "/", has no
// backslashes, and no empty / "." / ".." segment.
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// UTF-8 byte order for output rows.
const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// ---------------------------------------------------------------- files

interface FileData {
  lines: string[]; // file content split at line breaks; no break chars
  crlf: boolean; // true when the file's line break is CRLF
  finalBreak: boolean; // true when the file ends with a line break
}

// Split raw content into lines. A file's line break is CRLF when its first
// \n is preceded by \r, otherwise LF. The empty file has no lines and no
// final break; a file that is exactly one break has one empty line.
function splitFile(content: string): FileData {
  if (content === '') return { lines: [], crlf: false, finalBreak: false };
  const nl = content.indexOf('\n');
  const crlf = nl > 0 && content[nl - 1] === '\r';
  const finalBreak = content.endsWith('\n');
  const sep = crlf ? '\r\n' : '\n';
  const lines = content.split(sep);
  if (finalBreak) lines.pop();
  return { lines, crlf, finalBreak };
}

function joinFile(f: FileData): string {
  const sep = f.crlf ? '\r\n' : '\n';
  if (f.lines.length === 0) return '';
  return f.lines.join(sep) + (f.finalBreak ? sep : '');
}

// Split patch text into lines. The empty piece after a final \n is dropped;
// a blank line at the start is kept (it is a line of the patch). One trailing
// \r is removed from each line, so CRLF patches read as LF.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------- tree

// An in-memory overlay of the working tree. Files are read lazily from
// disk; writes go to the overlay until the end, when everything is flushed
// (or nothing is, when any edit failed). A null entry means "deleted".
class Tree {
  root: string;
  now: Map<string, FileData | null> = new Map();
  origExists: Map<string, boolean> = new Map();
  // Original on-disk content, recorded on first touch, never modified.
  before: Map<string, FileData | null> = new Map();

  constructor(root: string) {
    this.root = root;
  }

  // Record the on-disk state of a path on first touch.
  noteBefore(path: string): void {
    if (this.before.has(path)) return;
    const full = join(this.root, path);
    if (existsSync(full) && statSync(full).isFile()) {
      this.before.set(path, splitFile(readFileSync(full, 'utf8')));
    } else {
      this.before.set(path, null);
    }
  }

  // Did the file exist in the tree before any edit?
  existedBefore(path: string): boolean {
    this.noteBefore(path);
    return this.before.get(path) !== null;
  }

  // Original content, or null when the file did not exist before.
  contentBefore(path: string): FileData | null {
    this.noteBefore(path);
    return this.before.get(path) as FileData | null;
  }

  // Does the file exist in the tree as it stands now?
  exists(path: string): boolean {
    if (this.now.has(path)) return this.now.get(path) !== null;
    const onDisk = existsSync(join(this.root, path)) && statSync(join(this.root, path)).isFile();
    this.origExists.set(path, onDisk);
    return onDisk;
  }

  read(path: string): FileData {
    this.noteBefore(path);
    const cur = this.now.get(path);
    if (cur !== undefined && cur !== null) return cur;
    const raw = readFileSync(join(this.root, path), 'utf8');
    const data = splitFile(raw);
    this.now.set(path, data);
    return data;
  }

  write(path: string, data: FileData): void {
    this.noteBefore(path);
    this.now.set(path, data);
  }

  delete(path: string): void {
    this.noteBefore(path);
    this.now.set(path, null);
  }

  // Flush all overlay changes to disk.
  flush(): void {
    for (const [path, data] of this.now) {
      const full = join(this.root, path);
      if (data === null) {
        if (existsSync(full)) unlinkSync(full);
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, joinFile(data), 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------- matching

// Tier 0: exact. Tier 1: trailing spaces/tabs stripped both sides.
// Tier 2: leading and trailing spaces/tabs stripped both sides.
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Find every start index where oldLines occurs in fileLines at the given
// tier. Overlapping positions count; occurrences may start at any line.
function occurrences(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(fileLines[i + j], tier) !== norm(oldLines[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, 1, 2 — or only 0 when strict) with at least one occurrence.
// Returns the tier and its occurrences, or null when there is none.
function firstTier(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; at: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const at = occurrences(fileLines, oldLines, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// Leading whitespace (spaces and tabs) of a line.
function leadingWs(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// Re-indent a new line at tier 2: when the line is not empty and not
// whitespace-only and it starts with the old first line's leading
// whitespace P, replace that prefix with F (the file's first matched
// line's leading whitespace). An empty P matches every line, so F is
// prepended. Context lines are never re-indented: they are written as the
// file's own matched lines.
function reindent(line: string, firstFileLine: string, firstOldLine: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  const p = leadingWs(firstOldLine);
  if (!line.startsWith(p)) return line;
  const f = leadingWs(firstFileLine);
  return f + line.slice(p.length);
}

// ---------------------------------------------------------------- edits

// One edit produced by a format parser. Applying it mutates the tree;
// output rows are computed from the tree's before/after state at the end.
interface Edit {
  // One of: 'create' | 'delete' | 'change' | 'move' | 'noop'.
  kind: string;
  path: string; // for a move, the NEW path
  oldPath?: string; // for a move, the OLD path
  apply: (tree: Tree, strict: boolean) => void;
}

// Move pairs recorded by move edits, for net-change output rows.
const recordedMoves: [string, string][] = [];

// Apply a context+removed -> context+added replacement to a file's lines.
// oldLines / newLines are the full O and N sequences. `at` is the chosen
// occurrence start and `tier` the matching tier. `contextAt[i]` is the
// offset of the file line to use for new line i when it is a context line,
// or null when the line is an added line. Returns the new lines. Context
// lines are written as the file's own matched lines; at tier 2 the other
// new lines are re-indented.
function spliceLines(
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
  contextAt: (number | null)[],
  at: number,
  tier: number,
): string[] {
  const firstFile = fileLines[at];
  const firstOld = oldLines[0];
  const out: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    const src = contextAt[i];
    if (src !== null && src !== undefined) {
      out.push(fileLines[at + src]);
    } else if (tier === 2) {
      out.push(reindent(newLines[i], firstFile, firstOld));
    } else {
      out.push(newLines[i]);
    }
  }
  return [...fileLines.slice(0, at), ...out, ...fileLines.slice(at + oldLines.length)];
}

// The final-break rule for a replaced region: when the matched lines run
// to the end of the file (or an empty old block inserts at the end), the
// result ends with a break UNLESS a backslash line follows the hunk's last
// context or "+" line. Otherwise the file's final break is unchanged.
function finalBreakAfter(
  file: FileData,
  at: number,
  oldLen: number,
  insertAtEnd: boolean,
  backslash: boolean,
): boolean {
  const touchesEnd = insertAtEnd || at + oldLen >= file.lines.length;
  if (touchesEnd) return !backslash;
  return file.finalBreak;
}

// ---------------------------------------------------------------- unified

interface Hunk {
  a: number; // old start, 1-based
  c: number; // new start, 1-based
  body: string[]; // body lines, trailing empty lines dropped
  backslashAfter: boolean[]; // per body line: a "\" line follows it
}

interface UnifiedSection {
  oldPath: string | null; // null when old is /dev/null
  newPath: string | null; // null when new is /dev/null
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

// A header path: up to the first tab, trimmed, leading "a/" or "b/"
// stripped. "/dev/null" means no file.
function headerPath(text: string): string | null {
  let p = text.split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

// Split a hunk body into old lines, new lines and the context mapping,
// plus whether a "\" line follows the hunk's last context or "+" line,
// and whether one follows its last "+" line (for file creation).
function hunkParts(h: Hunk): {
  o: string[];
  n: string[];
  contextAt: (number | null)[];
  backslash: boolean;
  plusLines: string[];
  lastPlusBackslash: boolean | null;
} {
  const o: string[] = [];
  const n: string[] = [];
  const contextAt: (number | null)[] = [];
  const plusLines: string[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < h.body.length; k++) {
    const line = h.body[k];
    if (line.startsWith(' ')) {
      o.push(line.slice(1));
      n.push(line.slice(1));
      contextAt.push(o.length - 1);
      lastCtxOrPlus = k;
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push(line.slice(1));
      contextAt.push(null);
      plusLines.push(line.slice(1));
      lastCtxOrPlus = k;
      lastPlus = k;
    } else if (line === '') {
      o.push('');
      n.push('');
      contextAt.push(o.length - 1);
      lastCtxOrPlus = k;
    }
  }
  return {
    o,
    n,
    contextAt,
    backslash: lastCtxOrPlus >= 0 ? h.backslashAfter[lastCtxOrPlus] : false,
    plusLines,
    lastPlusBackslash: lastPlus >= 0 ? h.backslashAfter[lastPlus] : null,
  };
}

// Apply a section's hunks in order to a file's lines. `d` tracks the
// accumulated line-count shift so later hunks target the right place.
function applyHunks(file: FileData, hunks: Hunk[], strict: boolean, path: string): FileData {
  let lines = [...file.lines];
  let finalBreak = file.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const parts = hunkParts(h);
    const o = parts.o;
    const n = parts.n;
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const insertAtEnd = at >= lines.length;
      lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
      if (insertAtEnd) finalBreak = !parts.backslash;
      d += n.length;
      continue;
    }
    const hit = firstTier(lines, o, strict);
    if (!hit) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = hit.at[0];
    let bestDist = Math.abs(best - target);
    for (const pos of hit.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) { best = pos; bestDist = dist; }
    }
    const at = best;
    const touchesEnd = at + o.length >= lines.length;
    lines = spliceLines(lines, o, n, parts.contextAt, at, hit.tier);
    if (touchesEnd) finalBreak = !parts.backslash;
    d += n.length - o.length;
  }
  return { lines, crlf: file.crlf, finalBreak };
}

// Parse one hunk starting at lines[i] (a "@@" line). Returns the hunk and
// the index of the first line after its body.
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const line = lines[i];
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) throw new ParseFail(i + 1);
  const a = parseInt(m[1], 10);
  const c = parseInt(m[3], 10);
  const body: string[] = [];
  const backslashAfter: boolean[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      if (body.length > 0) backslashAfter[body.length - 1] = true;
      j++;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      body.push(l);
      backslashAfter.push(false);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
    backslashAfter.pop();
  }
  return { hunk: { a, c, body, backslashAfter }, next: j };
}

// Parse a unified patch into sections. Non-header lines outside bodies are
// ignored; a hunk before any section is a parse error.
function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (!m) throw new ParseFail(i + 1);
      const sec: UnifiedSection = {
        oldPath: m[1],
        newPath: m[2],
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i++;
      i = parseSectionHeader(lines, i, sec, sections, true);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const sec: UnifiedSection = {
        oldPath: headerPath(line.slice(4)),
        newPath: headerPath(lines[i + 1].slice(4)),
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i += 2;
      i = parseSectionHeader(lines, i, sec, sections, false);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFail(i + 1);
    i++;
  }
  return sections;
}

// Parse the header lines (and hunks) of one section starting at lines[i].
// `startedByDiffGit` is true when the section began with a `diff --git`
// line: then a `--- `+`+++ ` pair in its header sets the paths. Otherwise
// such a pair starts a new section. Returns the index of the first line
// after the section.
function parseSectionHeader(lines: string[], i: number, sec: UnifiedSection, sections: UnifiedSection[], startedByDiffGit: boolean): number {
  // True once a `---`/`+++` pair has named this section's paths. A section
  // that started at such a pair already has them; `rename from` / `rename
  // to` lines name the paths only when no pair does (section 6), so they
  // must not overwrite pair-set paths.
  let pairSet = !startedByDiffGit;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git')) return i;
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        if (sec.hunks.length === 0 && startedByDiffGit) {
          sec.oldPath = headerPath(line.slice(4));
          sec.newPath = headerPath(lines[i + 1].slice(4));
          pairSet = true;
          i += 2;
          continue;
        }
        return i;
      }
      if (sec.hunks.length === 0) throw new ParseFail(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (!pairSet) sec.oldPath = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (!pairSet) sec.newPath = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.deletedFile = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  return i;
}

// Turn a parsed unified section into an edit.
function unifiedToEdit(sec: UnifiedSection): Edit {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  // Creation: old is /dev/null or "new file mode".
  if (oldPath === null || sec.newFile) {
    const p = newPath as string;
    return {
      kind: 'create',
      path: p,
      apply: (tree) => {
        if (!isSafePath(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        const plusLines: string[] = [];
        let lastPlusBackslash: boolean | null = null;
        for (const h of sec.hunks) {
          const parts = hunkParts(h);
          plusLines.push(...parts.plusLines);
          if (parts.lastPlusBackslash !== null) lastPlusBackslash = parts.lastPlusBackslash;
        }
        tree.write(p, {
          lines: plusLines,
          crlf: false,
          finalBreak: lastPlusBackslash === null ? true : !lastPlusBackslash,
        });
      },
    };
  }
  // Deletion: new is /dev/null or "deleted file mode". Hunks are parsed
  // (malformed @@ is still a parse error) but not applied.
  if (newPath === null || sec.deletedFile) {
    const p = oldPath;
    return {
      kind: 'delete',
      path: p,
      apply: (tree) => {
        if (!isSafePath(p)) throw new Fail('unsafe', p);
        if (!tree.exists(p)) throw new Fail('missing', p);
        tree.delete(p);
      },
    };
  }
  // Move: old and new differ.
  if (oldPath !== newPath) {
    return {
      kind: 'move',
      path: newPath,
      oldPath,
      apply: (tree, strict) => {
        if (!isSafePath(oldPath)) throw new Fail('unsafe', oldPath);
        if (!isSafePath(newPath)) throw new Fail('unsafe', newPath);
        if (!tree.exists(oldPath)) throw new Fail('missing', oldPath);
        if (tree.exists(newPath)) throw new Fail('exists', newPath);
        const file = tree.read(oldPath);
        const result = applyHunks(file, sec.hunks, strict, oldPath);
        tree.delete(oldPath);
        tree.write(newPath, result);
        recordedMoves.push([oldPath, newPath]);
      },
    };
  }
  // Change.
  return {
    kind: 'change',
    path: oldPath,
    apply: (tree, strict) => {
      if (!isSafePath(oldPath)) throw new Fail('unsafe', oldPath);
      if (!tree.exists(oldPath)) throw new Fail('missing', oldPath);
      const file = tree.read(oldPath);
      const result = applyHunks(file, sec.hunks, strict, oldPath);
      tree.write(oldPath, result);
    },
  };
}

// ---------------------------------------------------------------- search-replace

// A search/replace block: path, old lines, new lines, and the line number
// of its SEARCH marker (for parse errors).
interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLine: number; // 1-based line number of the <<<<<<< SEARCH line
}

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_MID = '=======';
const SR_END = '>>>>>>> REPLACE';

// Markers are matched with trailing whitespace removed.
function isMarker(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, '') === marker;
}

// Parse search/replace blocks. Lines outside blocks are ignored.
function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevEnd = -1; // index just after the previous block's REPLACE line
  while (i < lines.length) {
    if (!isMarker(lines[i], SR_SEARCH)) { i++; continue; }
    const searchLine = i + 1;
    // Path: nearest non-blank, non-fence line before SEARCH after the
    // previous block's REPLACE (or the patch start).
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new ParseFail(searchLine);
      path = blocks[blocks.length - 1].path;
    }
    // Collect the old lines up to =======.
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !isMarker(lines[j], SR_MID)) {
      oldLines.push(lines[j]);
      j++;
    }
    if (j >= lines.length) throw new ParseFail(searchLine);
    // Collect the new lines up to >>>>>>> REPLACE.
    const newLines: string[] = [];
    j++;
    while (j < lines.length && !isMarker(lines[j], SR_END)) {
      newLines.push(lines[j]);
      j++;
    }
    if (j >= lines.length) throw new ParseFail(searchLine);
    blocks.push({ path, oldLines, newLines, searchLine });
    prevEnd = j;
    i = j + 1;
  }
  return blocks;
}

function searchReplaceToEdit(b: SrBlock): Edit {
  return {
    kind: b.oldLines.length === 0 ? 'create' : 'change',
    path: b.path,
    apply: (tree, strict) => {
      if (!isSafePath(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.exists(b.path)) throw new Fail('exists', b.path);
        tree.write(b.path, { lines: [...b.newLines], crlf: false, finalBreak: true });
        return;
      }
      if (!tree.exists(b.path)) throw new Fail('missing', b.path);
      const file = tree.read(b.path);
      const hit = firstTier(file.lines, b.oldLines, strict);
      if (!hit) throw new Fail('no-match', b.path);
      if (hit.at.length > 1) throw new Fail('ambiguous', b.path);
      const at = hit.at[0];
      const contextAt: (number | null)[] = b.newLines.map(() => null);
      const lines = spliceLines(file.lines, b.oldLines, b.newLines, contextAt, at, hit.tier);
      tree.write(b.path, { lines, crlf: file.crlf, finalBreak: file.finalBreak });
    },
  };
}

// ---------------------------------------------------------------- v4a

interface V4aChunk {
  anchor: string | null; // null = no anchor
  body: string[]; // body lines
  eof: boolean; // "*** End of File" ended this chunk
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number; // 1-based line number of the section header
  lines: { text: string; no: number }[]; // content lines, trailing blanks stripped
}

// Find the first line at/after `from` equal to the anchor, at the first
// tier with one. Returns the line index, or null.
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i], tier) === norm(anchor, tier)) return i;
    }
  }
  return null;
}

// First tier with at least one occurrence of oldLines starting at/after
// `from`. Returns the tier and its occurrences, or null.
function firstTierFrom(fileLines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const at = occurrences(fileLines, oldLines, tier).filter((i) => i >= from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// Split a v4a chunk body into old lines, new lines and the context mapping.
function v4aChunkParts(chunk: V4aChunk): { o: string[]; n: string[]; contextAt: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const contextAt: (number | null)[] = [];
  for (const line of chunk.body) {
    if (line.startsWith(' ')) {
      o.push(line.slice(1));
      n.push(line.slice(1));
      contextAt.push(o.length - 1);
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push(line.slice(1));
      contextAt.push(null);
    } else if (line === '') {
      o.push('');
      n.push('');
      contextAt.push(o.length - 1);
    }
  }
  return { o, n, contextAt };
}

// Parse a v4a patch into sections.
function parseV4a(lines: string[]): V4aSection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { last = i; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);

  const sections: V4aSection[] = [];
  let current: V4aSection | null = null;
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      if (current) current.lines.push({ text: line, no: i + 1 });
      i++;
      continue;
    }
    const kind = line.startsWith('*** Add File: ')
      ? 'add'
      : line.startsWith('*** Delete File: ')
        ? 'delete'
        : line.startsWith('*** Update File: ')
          ? 'update'
          : null;
    if (kind) {
      if (current) sections.push(current);
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      current = { kind, path: line.slice(prefix.length).trim(), headerLine: i + 1, lines: [] };
      i++;
      continue;
    }
    if (current) {
      current.lines.push({ text: line, no: i + 1 });
      i++;
      continue;
    }
    throw new ParseFail(i + 1);
  }
  if (current) sections.push(current);
  // Strip trailing blank lines from each section.
  for (const sec of sections) {
    while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1].text.trim() === '') {
      sec.lines.pop();
    }
  }
  return sections;
}

// Parse an update section's content into a Move-to target and chunks.
function parseV4aUpdate(sec: V4aSection): { moveTo: string | null; chunks: V4aChunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.lines.length > 0 && sec.lines[0].text.startsWith('*** Move to: ')) {
    moveTo = sec.lines[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (; idx < sec.lines.length; idx++) {
    const { text, no } = sec.lines[idx];
    if (text.startsWith('@@')) {
      if (cur) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), body: [], eof: false };
      continue;
    }
    if (text.replace(/[ \t]+$/, '') === '*** End of File') {
      if (!cur) throw new ParseFail(no);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (!cur) cur = { anchor: null, body: [], eof: false };
      cur.body.push(text);
      continue;
    }
    throw new ParseFail(no);
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new ParseFail(sec.headerLine);
  return { moveTo, chunks };
}

// Apply an update section's chunks in order to a file's lines, with a
// cursor that starts at line 0 and moves past what each chunk writes.
function applyV4aChunks(file: FileData, chunks: V4aChunk[], strict: boolean, path: string): FileData {
  let lines = [...file.lines];
  let cursor = 0;
  for (const chunk of chunks) {
    const parts = v4aChunkParts(chunk);
    const o = parts.o;
    const n = parts.n;
    if (chunk.anchor !== null) {
      const idx = findAnchor(lines, chunk.anchor, cursor, strict);
      if (idx === null) throw new Fail('no-match', path);
      cursor = idx + 1;
    }
    if (o.length === 0) {
      const at = chunk.eof ? lines.length : cursor;
      lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
      cursor = at + n.length;
      continue;
    }
    if (chunk.eof) {
      const want = lines.length - o.length;
      if (want < cursor) throw new Fail('no-match', path);
      const maxTier = strict ? 0 : 2;
      let tier = -1;
      for (let t = 0; t <= maxTier; t++) {
        let ok = true;
        for (let k = 0; k < o.length; k++) {
          if (norm(lines[want + k], t) !== norm(o[k], t)) { ok = false; break; }
        }
        if (ok) { tier = t; break; }
      }
      if (tier === -1) throw new Fail('no-match', path);
      lines = spliceLines(lines, o, n, parts.contextAt, want, tier);
      cursor = want + n.length;
      continue;
    }
    const hit = firstTierFrom(lines, o, cursor, strict);
    if (!hit) throw new Fail('no-match', path);
    const at = hit.at[0];
    lines = spliceLines(lines, o, n, parts.contextAt, at, hit.tier);
    cursor = at + n.length;
  }
  return { lines, crlf: file.crlf, finalBreak: file.finalBreak };
}

function v4aToEdit(sec: V4aSection): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, no } of sec.lines) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new ParseFail(no);
    }
    return {
      kind: 'create',
      path: sec.path,
      apply: (tree) => {
        if (!isSafePath(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.exists(sec.path)) throw new Fail('exists', sec.path);
        tree.write(sec.path, { lines: fileLines, crlf: false, finalBreak: true });
      },
    };
  }
  if (sec.kind === 'delete') {
    if (sec.lines.length > 0) throw new ParseFail(sec.lines[0].no);
    return {
      kind: 'delete',
      path: sec.path,
      apply: (tree) => {
        if (!isSafePath(sec.path)) throw new Fail('unsafe', sec.path);
        if (!tree.exists(sec.path)) throw new Fail('missing', sec.path);
        tree.delete(sec.path);
      },
    };
  }
  const { moveTo, chunks } = parseV4aUpdate(sec);
  if (moveTo !== null) {
    return {
      kind: 'move',
      path: moveTo,
      oldPath: sec.path,
      apply: (tree, strict) => {
        if (!isSafePath(sec.path)) throw new Fail('unsafe', sec.path);
        if (!isSafePath(moveTo)) throw new Fail('unsafe', moveTo);
        if (!tree.exists(sec.path)) throw new Fail('missing', sec.path);
        if (tree.exists(moveTo)) throw new Fail('exists', moveTo);
        const file = tree.read(sec.path);
        const result = applyV4aChunks(file, chunks, strict, sec.path);
        tree.delete(sec.path);
        tree.write(moveTo, result);
        recordedMoves.push([sec.path, moveTo]);
      },
    };
  }
  return {
    kind: 'change',
    path: sec.path,
    apply: (tree, strict) => {
      if (!isSafePath(sec.path)) throw new Fail('unsafe', sec.path);
      if (!tree.exists(sec.path)) throw new Fail('missing', sec.path);
      const file = tree.read(sec.path);
      const result = applyV4aChunks(file, chunks, strict, sec.path);
      tree.write(sec.path, result);
    },
  };
}

// ---------------------------------------------------------------- json

// Split an insert's new_str into lines: split at \n, drop the empty piece
// after a final \n, remove one trailing \r from each line. Empty new_str
// means no lines.
function splitInsertLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

// Count overlapping occurrences of needle in hay, returning the count and
// the first index.
function countOccurrences(hay: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let pos = 0;
  while (true) {
    const idx = hay.indexOf(needle, pos);
    if (idx === -1) break;
    if (first === -1) first = idx;
    count++;
    pos = idx + 1;
  }
  return { count, first };
}

// Turn one JSON edit object into an edit. `lineNo` is the 1-based line
// the object came from (the array-start line for the array form).
function jsonObjectToEdit(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseFail(lineNo);
  const o = obj as Record<string, unknown>;
  const command = o.command;
  if (command === 'create') {
    if (typeof o.path !== 'string' || typeof o.file_text !== 'string') throw new ParseFail(lineNo);
    const path = o.path;
    const fileText = o.file_text;
    return {
      kind: 'create',
      path,
      apply: (tree) => {
        if (!isSafePath(path)) throw new Fail('unsafe', path);
        if (tree.exists(path)) throw new Fail('exists', path);
        tree.write(path, splitFile(fileText));
      },
    };
  }
  if (command === 'str_replace') {
    if (typeof o.path !== 'string' || typeof o.old_str !== 'string' || o.old_str === '') throw new ParseFail(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseFail(lineNo);
    const path = o.path;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      kind: 'change',
      path,
      apply: (tree) => {
        if (!isSafePath(path)) throw new Fail('unsafe', path);
        if (!tree.exists(path)) throw new Fail('missing', path);
        const file = tree.read(path);
        const text = joinFile(file);
        let hay = text;
        let needle = oldStr;
        let repl = newStr;
        if (file.crlf) {
          hay = text.replace(/\r\n/g, '\n');
          needle = oldStr.replace(/\r\n/g, '\n');
          repl = newStr.replace(/\r\n/g, '\n');
        }
        const { count, first } = countOccurrences(hay, needle);
        if (count === 0) throw new Fail('no-match', path);
        if (count > 1) throw new Fail('ambiguous', path);
        let result = hay.slice(0, first) + repl + hay.slice(first + needle.length);
        if (file.crlf) result = result.replace(/\n/g, '\r\n');
        tree.write(path, splitFile(result));
      },
    };
  }
  if (command === 'insert') {
    if (typeof o.path !== 'string' || typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') throw new ParseFail(lineNo);
    const path = o.path;
    const insertLine = o.insert_line as number;
    const newStr = o.new_str as string;
    return {
      kind: 'change',
      path,
      apply: (tree) => {
        if (!isSafePath(path)) throw new Fail('unsafe', path);
        if (!tree.exists(path)) throw new Fail('missing', path);
        const file = tree.read(path);
        if (insertLine < 0 || insertLine > file.lines.length) throw new Fail('no-match', path);
        const newLines = splitInsertLines(newStr);
        const lines = [...file.lines.slice(0, insertLine), ...newLines, ...file.lines.slice(insertLine)];
        tree.write(path, { lines, crlf: file.crlf, finalBreak: file.finalBreak });
      },
    };
  }
  throw new ParseFail(lineNo);
}

// Parse a JSON patch: one array of edit objects, or JSON Lines (one object
// per line, blank lines ignored).
function parseJson(lines: string[], rawText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx === -1) throw new ParseFail(1);
  const firstLine = lines[firstIdx].trimStart();
  if (firstLine.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseFail(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFail(firstIdx + 1);
    return arr.map((obj) => jsonObjectToEdit(obj, firstIdx + 1));
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseFail(i + 1);
    }
    edits.push(jsonObjectToEdit(obj, i + 1));
  }
  return edits;
}

// ---------------------------------------------------------------- detection

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// Format detection, in the spec's order: v4a, json, search-replace,
// unified. Returns null when no format matches.
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === SR_SEARCH)) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- output

// Compute the output rows from the tree's before/after state. A move is
// reported as "R <old> -> <new>" only when the old path existed before and
// is gone after, and the new path did not exist before and does after;
// chained moves collapse to one R row. Rows are sorted by path in UTF-8
// byte order (R rows by their new path).
function computeRows(tree: Tree): string[] {
  const originOf = new Map<string, string>();
  for (const [o, n] of recordedMoves) {
    originOf.set(n, originOf.get(o) ?? o);
    originOf.delete(o);
  }
  const realR = new Map<string, string>(); // new path -> old path
  for (const [target, origin] of originOf) {
    if (tree.existedBefore(origin) && !tree.exists(origin) && !tree.existedBefore(target) && tree.exists(target)) {
      realR.set(target, origin);
    }
  }
  const rows: { key: string; row: string }[] = [];
  for (const p of tree.now.keys()) {
    const before = tree.contentBefore(p);
    const after = tree.now.get(p) as FileData | null;
    const be = before !== null;
    const ae = after !== null;
    if (!be && !ae) continue;
    if (realR.has(p)) {
      rows.push({ key: p, row: `R ${realR.get(p)} -> ${p}` });
      continue;
    }
    if (be && !ae) {
      let covered = false;
      for (const origin of realR.values()) {
        if (origin === p) { covered = true; break; }
      }
      if (!covered) rows.push({ key: p, row: `D ${p}` });
      continue;
    }
    if (!be && ae) {
      rows.push({ key: p, row: `A ${p}` });
      continue;
    }
    if (be && ae && joinFile(before as FileData) !== joinFile(after as FileData)) {
      rows.push({ key: p, row: `M ${p}` });
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows.map((r) => r.row);
}

// ---------------------------------------------------------------- run

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0] as string;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(lines, text);
    else if (kind === 'unified') edits = parseUnified(lines).map(unifiedToEdit);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map(searchReplaceToEdit);
    else if (kind === 'v4a') edits = parseV4a(lines).map(v4aToEdit);
    else return { code: 2, out: ['error: format'] };
    if (edits.length === 0) throw new ParseFail(1);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree(process.cwd());
  recordedMoves.length = 0;
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.message}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = computeRows(tree);
  if (!check) tree.flush();
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------- handover

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  process.stdout.write(r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
