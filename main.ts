// main.ts is mend, the CLI SPEC.md specifies. It implements the whole of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, all four patch formats (unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits), matching lines at three tiers, and the all-or-nothing write. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Moves a successful move edit made: [old path, new path], for the `R` output line. */
  readonly moves: Array<[string, string]> = [];
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimRightWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Whether two lines are equal at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** 0-based positions at or after `from` where O's lines match, at one tier. */
function occurrencesAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence of O at or after `from`, or null. */
function findTier(O: string[], lines: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesAt(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The lines N writes when it replaces O matched at `at` in `lines` (SPEC.md section 5).
 * `ctx[k]` is the index in O of the context line N[k] repeats, or -1 for a new line.
 * A context line is written as the file's own matched line; at tier 2 every other line
 * of N is re-indented from O's first line's leading whitespace to the file's.
 */
function renderN(N: string[], ctx: number[], lines: string[], at: number, O: string[], tier: number): string[] {
  if (O.length === 0) return N.slice();
  const out: string[] = [];
  const F = at < lines.length ? leadingWs(lines[at]!) : '';
  const P = leadingWs(O[0]!);
  for (let k = 0; k < N.length; k++) {
    const j = ctx[k]!;
    if (j >= 0) {
      out.push(lines[at + j]!);
      continue;
    }
    const line = N[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
    else out.push(line);
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
  raw: string;
}

interface UniHunk {
  A: number;
  O: string[];
  N: string[];
  ctx: number[];
  body: BodyLine[];
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

/** O, N and the context map of a hunk or chunk body. */
function bodyParts(body: BodyLine[]): { O: string[]; N: string[]; ctx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      ctx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') {
      ctx.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, ctx };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noEolAfterLast(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** The path of a `--- ` / `+++ ` line, or null for `/dev/null`. */
function uniPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function applyUniHunk(f: FileText, h: UniHunk, d: number, maxTier: number, path: string): FileText {
  if (h.O.length === 0 && h.N.length === 0) return f;
  if (h.O.length > 0) {
    const found = findTier(h.O, f.lines, 0, maxTier);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const o of found.occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        at = o;
        best = dist;
      }
    }
    const rendered = renderN(h.N, h.ctx, f.lines, at, h.O, found.tier);
    const lines = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + h.O.length)];
    let final = f.final;
    if (at + h.O.length === f.lines.length) final = !noEolAfterLast(h.body);
    return { lines, br: f.br, final };
  }
  const pos = Math.max(0, Math.min(h.A + d, f.lines.length));
  const lines = [...f.lines.slice(0, pos), ...h.N, ...f.lines.slice(pos)];
  let final = f.final;
  if (pos === f.lines.length) final = !noEolAfterLast(h.body);
  return { lines, br: f.br, final };
}

/** Whether a `\` line follows the last `+` line of a creation's hunks. */
function createNoEol(hunks: UniHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === '+') return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

function unifiedEdit(sec: UniSection, maxTier: number): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld !== undefined ? sec.gitOld : null;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew !== undefined ? sec.gitNew : null;
  const isCreate = sec.create || oldP === null;
  const isDelete = !isCreate && (sec.del || newP === null);
  const plusLines: string[] = [];
  for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plusLines.push(b.text);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, plusLines.length === 0 ? '' : plusLines.join('\n') + (createNoEol(sec.hunks) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let f = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        f = applyUniHunk(f, h, d, maxTier, oldP!);
        d += h.N.length - h.O.length;
      }
      tree.now.set(newP!, joinFile(f));
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyUniHunk(f, h, d, maxTier, oldP!);
      d += h.N.length - h.O.length;
    }
    tree.now.set(oldP!, joinFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headerDone = false;
  let hasPair = false;
  const newSection = (oldP: string | null | undefined, newP: string | null | undefined, gitOld?: string, gitNew?: string): void => {
    cur = { pairOld: oldP, pairNew: newP, gitOld, gitNew, renameFrom: undefined, renameTo: undefined, create: false, del: false, hunks: [] };
    sections.push(cur);
    headerDone = false;
    hasPair = oldP !== undefined;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(undefined, undefined, m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = Number(m[1]);
      let j = i + 1;
      const body: BodyLine[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push({ kind: (l === '' ? ' ' : l[0]!) as BodyKind, text: l === '' ? '' : l.slice(1), raw: l });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      const { O, N, ctx } = bodyParts(body);
      cur.hunks.push({ A, O, N, ctx, body });
      headerDone = true;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || headerDone || hasPair) {
        newSection(uniPath(line), uniPath(lines[i + 1]!));
      } else {
        cur.pairOld = uniPath(line);
        cur.pairNew = uniPath(lines[i + 1]!);
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, maxTier));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SRBlock, maxTier: number): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(b.oldLines, f.lines, 0, maxTier);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const rendered = renderN(b.newLines, b.newLines.map(() => -1), f.lines, at, b.oldLines, found.tier);
    const lines = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let m = s - 1; m > prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, j), newLines: lines.slice(j + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, maxTier));
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  ctx: number[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4aChunk(f: FileText, ch: V4aChunk, cursor: number, maxTier: number, path: string): { f: FileText; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    let foundIdx = -1;
    for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
      for (let idx = cur; idx < f.lines.length; idx++) {
        if (lineEq(ch.anchor, f.lines[idx]!, t)) {
          foundIdx = idx;
          break;
        }
      }
    }
    if (foundIdx < 0) throw new Fail('no-match', path);
    cur = foundIdx + 1;
  }
  if (ch.O.length === 0) {
    const pos = ch.eof ? f.lines.length : cur;
    const lines = [...f.lines.slice(0, pos), ...ch.N, ...f.lines.slice(pos)];
    return { f: { lines, br: f.br, final: f.final }, cursor: pos + ch.N.length };
  }
  const found = findTier(ch.O, f.lines, cur, maxTier);
  if (found === null) throw new Fail('no-match', path);
  let occ = found.occ;
  if (ch.eof) occ = occ.filter((o) => o + ch.O.length === f.lines.length);
  if (occ.length === 0) throw new Fail('no-match', path);
  const at = occ[0]!;
  const rendered = renderN(ch.N, ch.ctx, f.lines, at, ch.O, found.tier);
  const lines = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + ch.O.length)];
  return { f: { lines, br: f.br, final: f.final }, cursor: at + rendered.length };
}

function v4aUpdateEdit(path: string, content: string[], base: number, headerLine: number, maxTier: number): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let pos = 0;
  if (pos < content.length && content[pos]!.startsWith('*** Move to: ')) {
    moveTo = content[pos]!.slice(13).trim();
    pos++;
  }
  let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
  let chunkStarted = false;
  const flush = (): void => {
    if (cur !== null) {
      const { O, N, ctx } = bodyParts(cur.body);
      chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N, ctx });
      cur = null;
    }
  };
  while (pos < content.length) {
    const l = content[pos]!;
    const ln = base + pos;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      flush();
      chunkStarted = true;
      pos++;
      continue;
    }
    if (l.startsWith('@@')) {
      flush();
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      chunkStarted = true;
      pos++;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${ln}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunkStarted) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, body: [] };
        chunkStarted = true;
      }
      cur.body.push({ kind: (l === '' ? ' ' : l[0]!) as BodyKind, text: l === '' ? '' : l.slice(1), raw: l });
      pos++;
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(f, ch, cursor, maxTier, path);
      f = r.f;
      cursor = r.cursor;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (isSectionStart(line)) {
      let j = i + 1;
      const content: string[] = [];
      while (j < last && !isSectionStart(lines[j]!)) {
        content.push(lines[j]!);
        j++;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      const base = i + 2;
      if (line.startsWith('*** Add File: ')) {
        const path = line.slice(14).trim();
        const fileLines: string[] = [];
        for (let k = 0; k < content.length; k++) {
          const c = content[k]!;
          if (c === '') fileLines.push('');
          else if (c.startsWith('+')) fileLines.push(c.slice(1));
          else throw new Exit2(`error: parse ${base + k}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (line.startsWith('*** Delete File: ')) {
        const path = line.slice(17).trim();
        for (let k = 0; k < content.length; k++) {
          if (!blank(content[k]!)) throw new Exit2(`error: parse ${base + k}`);
        }
        edits.push(v4aDeleteEdit(path));
      } else {
        const path = line.slice(17).trim();
        edits.push(v4aUpdateEdit(path, content, base, i + 1, maxTier));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const replaced = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      replaced.add(oldP);
      replaced.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (replaced.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.original(p) === tree.now.get(p) || tree.now.get(p) !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
