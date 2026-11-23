// mend: one command-line tool that applies the edits AI models write, in all four formats they write them in
// (unified diff, SEARCH/REPLACE blocks, V4A patches and JSON tool calls), to a tree of text files, changing every
// file or none. It implements SPEC.md end to end: the command line and its usage errors, the output lines and exit
// codes, safe paths, format detection, line matching at three tiers (exact, trailing-whitespace drift, indentation
// drift, with re-indentation of new lines at the third tier), the four readers and the all-or-nothing write.
//
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]` with the working directory as the
// root of the tree. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the whole run answers with this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One edit failed: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path: not empty, not absolute, no backslash, no empty, `.` or `..` segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, new path -> old path, for the `R` output line. */
  readonly moves = new Map<string, string>();
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
}

type Edit = (tree: Tree, strict: boolean) => void;

/* A file as lines: its own line break, its lines, and whether it ends with a line break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinFile(lines: string[], fin: boolean, br = '\n'): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/* Matching lines (SPEC.md section 5). Tier 0: equal. Tier 1: equal once trailing spaces and tabs go.
   Tier 2: equal once leading and trailing spaces and tabs go. */

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function eqLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function eqAt(lines: string[], i: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) if (!eqLine(lines[i + k]!, o[k]!, tier)) return false;
  return true;
}

/** The first tier at which O occurs at or after `from`, with every occurrence position at that tier. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      if (eqAt(lines, i, o, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk or chunk: ` ` context, `-` old, `+` new, `\` no-newline marker. */
interface BodyItem {
  t: string;
  s: string;
}

/**
 * The lines a matched hunk, chunk or block writes over the file's lines at `pos`: context lines are the file's own
 * matched lines; at tier 2 every other new line is re-indented from O's first line's indent to the file's.
 */
function buildSeg(fileLines: string[], pos: number, items: BodyItem[], o: string[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const F = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = o.length > 0 ? leadWs(o[0]!) : '';
  for (const it of items) {
    if (it.t === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.t === '-') {
      oi += 1;
    } else if (it.t === '+') {
      let s = it.s;
      if (tier === 2 && o.length > 0 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}

/** Format detection (SPEC.md section 4): the first rule that holds. */
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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f.lines, f.final, f.br));
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

/* Unified diffs (SPEC.md section 6). */

interface UHunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line: the result gets no final line break. */
  noEolNew: boolean;
  /** A `\` line follows the hunk's last `+` line (what a creation looks at). */
  noEolPlus: boolean;
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path on a `--- `/`+++ ` line: after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** A leading `a/` or `b/` is removed from a `--- `/`+++ ` path; `/dev/null` is left alone. */
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let pairSeen = false;
  let inHeader = false;
  let i = 0;
  const pairAt = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sp = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sp <= 2 || sp + 3 >= rest.length) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: rest.slice(2, sp), gitNew: rest.slice(sp + 3), newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      pairSeen = false;
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      const o = stripPrefix(headerPath(line));
      const n = stripPrefix(headerPath(lines[i + 1]!));
      if (cur !== null && inHeader && !pairSeen) {
        cur.pairOld = o;
        cur.pairNew = n;
      } else {
        cur = { pairOld: o, pairNew: n, newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
      }
      pairSeen = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || pairAt(i)) break;
        if (bl === '') {
          body.push({ t: ' ', s: '' });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ t: c, s: bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.t === ' ' && body[body.length - 1]!.s === '') body.pop();
      let noEolNew = false;
      let noEolPlus = false;
      for (let j = body.length - 1; j >= 0; j -= 1) {
        if (body[j]!.t === ' ' || body[j]!.t === '+') {
          noEolNew = j + 1 < body.length && body[j + 1]!.t === '\\';
          break;
        }
      }
      for (let j = body.length - 1; j >= 0; j -= 1) {
        if (body[j]!.t === '+') {
          noEolPlus = j + 1 < body.length && body[j + 1]!.t === '\\';
          break;
        }
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), items: body, noEolNew, noEolPlus });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply one section's hunks in order to a file's lines; a hunk that finds nothing fails the section. */
function applyHunks(f: FileText, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = h.items.filter((it) => it.t === ' ' || it.t === '-').map((it) => it.s);
    if (o.length === 0) {
      const add = h.items.filter((it) => it.t === '+').map((it) => it.s);
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...add);
      if (atEnd) f.final = !h.noEolNew;
      d += add.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const q of found.positions) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const seg = buildSeg(f.lines, pos, h.items, o, found.tier);
    const reachesEnd = pos + o.length === f.lines.length;
    f.lines.splice(pos, o.length, ...seg);
    if (reachesEnd) f.final = !h.noEolNew;
    d += seg.length - o.length;
  }
}

function unifiedEdits(lines: string[]): Edit[] {
  return parseUnified(lines).map((s): Edit => {
    const oldP = s.pairOld ?? s.renameFrom ?? s.gitOld;
    const newP = s.pairNew ?? s.renameTo ?? s.gitNew;
    const isCreate = s.newFile || oldP === '/dev/null';
    const isDelete = s.delFile || newP === '/dev/null';
    return (tree, strict) => {
      if (isCreate) {
        const p = newP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        let noEol = false;
        for (const h of s.hunks) {
          for (const it of h.items) if (it.t === '+') out.push(it.s);
          if (h.items.some((it) => it.t === '+')) noEol = h.noEolPlus;
        }
        tree.now.set(p, joinFile(out, !noEol));
        return;
      }
      if (isDelete) {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const move = newP !== undefined && newP !== p ? newP : null;
      if (move !== null) {
        if (!safe(move)) throw new Fail('unsafe', move);
        if (tree.get(move) !== null) throw new Fail('exists', move);
      }
      const f = splitFile(text);
      applyHunks(f, s.hunks, strict, p);
      const outText = joinFile(f.lines, f.final, f.br);
      if (move !== null) {
        tree.now.set(p, null);
        tree.now.set(move, outText);
        tree.moves.set(move, p);
      } else {
        tree.now.set(p, outText);
      }
    };
  });
}

/* SEARCH/REPLACE blocks (SPEC.md section 7). */

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | undefined;
  let scanFrom = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    let p: string | undefined;
    for (let j = s - 1; j >= scanFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === undefined) p = prevPath;
    if (p === undefined) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = p;
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rp);
    const path = p;
    edits.push((tree, strict) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(newLines, true));
        return;
      }
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      const f = splitFile(text);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const items: BodyItem[] = [
        ...oldLines.map((x) => ({ t: '-', s: x })),
        ...newLines.map((x) => ({ t: '+', s: x })),
      ];
      const seg = buildSeg(f.lines, pos, items, oldLines, found.tier);
      f.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(path, joinFile(f.lines, f.final, f.br));
    });
    scanFrom = rp + 1;
    i = rp + 1;
  }
  return edits;
}

/* V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor?: string;
  items: BodyItem[];
  eof: boolean;
}

const V_HEADS: [string, string][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'del'],
  ['*** Update File: ', 'upd'],
];

function vHead(line: string): { kind: string; path: string } | null {
  for (const [prefix, kind] of V_HEADS) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = vHead(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i += 1;
    const raw: { s: string; n: number }[] = [];
    while (i < last) {
      const sl = lines[i]!;
      if (vHead(sl) !== null) break;
      if (sl.trim() === '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
      raw.push({ s: sl, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.s)) raw.pop();
    edits.push(v4aSection(head.kind, head.path, raw, secLine));
  }
  return edits;
}

/** Parse one V4A section's lines (structure faults are parse errors, here) and build its edit. */
function v4aSection(kind: string, path: string, raw: { s: string; n: number }[], secLine: number): Edit {
  if (kind === 'add') {
    const content: string[] = [];
    for (const { s, n } of raw) {
      if (s.startsWith('+')) content.push(s.slice(1));
      else if (s === '') content.push('');
      else throw new Exit2(`error: parse ${n}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(content, true));
    };
  }
  if (kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | undefined;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.s.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.s.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let eofClosed = false;
  for (; idx < raw.length; idx += 1) {
    const { s, n } = raw[idx]!;
    if (s.startsWith('@@')) {
      cur = { anchor: s.slice(2).trim() || undefined, items: [], eof: false };
      chunks.push(cur);
      eofClosed = false;
    } else if (s.trim() === '*** End of File' && !/^[ \-+]/.test(s)) {
      if (cur === null) {
        cur = { items: [], eof: false };
        chunks.push(cur);
      }
      cur.eof = true;
      eofClosed = true;
    } else if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
      if (eofClosed) throw new Exit2(`error: parse ${n}`);
      if (cur === null) {
        cur = { items: [], eof: false };
        chunks.push(cur);
      }
      cur.items.push(s === '' ? { t: ' ', s: '' } : { t: s[0]!, s: s.slice(1) });
    } else {
      throw new Exit2(`error: parse ${n}`);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== undefined) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== undefined) {
        const af = findTier(f.lines, [ch.anchor], strict, cursor);
        if (af === null) throw new Fail('no-match', path);
        cursor = af.positions[0]! + 1;
      }
      const o = ch.items.filter((it) => it.t === ' ' || it.t === '-').map((it) => it.s);
      if (o.length === 0) {
        const add = ch.items.filter((it) => it.t === '+').map((it) => it.s);
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const seg = buildSeg(f.lines, pos, ch.items, o, found.tier);
      f.lines.splice(pos, o.length, ...seg);
      cursor = pos + seg.length;
    }
    const outText = joinFile(f.lines, f.final, f.br);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, outText);
      tree.moves.set(moveTo, path);
    } else {
      tree.now.set(path, outText);
    }
  };
}

/* The run: parse the command line, read the patch, parse it into edits, apply them in order, write or don't. */

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
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? srEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!).sort(byBytes);
  const fin = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rOld = new Set<string>();
  const rNew = new Map<string, string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && fin(op) === null && tree.original(np) === null && fin(np) !== null) {
      rOld.add(op);
      rNew.set(np, op);
    }
  }
  const rows: string[] = [];
  for (const p of changed) {
    if (rOld.has(p)) continue;
    if (rNew.has(p)) rows.push(`R ${rNew.get(p)!} -> ${p}`);
    else {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    }
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
