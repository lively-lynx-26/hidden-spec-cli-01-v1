// mend — one patch tool for every AI edit format.
// Built from scratch for hidden-spec-cli-01-run-20261122.
// Node standard library only. Implements SPEC.md (version 1) sections 1-10.
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function out(line) {
  process.stdout.write(line + '\n');
}

// Split patch text into lines: split at \n, remove one trailing \r per line,
// drop the empty piece after a final \n.
function splitPatchLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ...
function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// A file's line model: its line break, its lines, whether it ends with one.
function parseFileText(text) {
  if (text === '') return { br: '\n', lines: [], end: false };
  const idx = text.indexOf('\n');
  let br = '\n';
  if (idx > 0 && text[idx - 1] === '\r') br = '\r\n';
  const parts = text.split(br);
  let end = false;
  if (text.endsWith(br)) {
    parts.pop();
    end = true;
  }
  return { br: br, lines: parts, end: end };
}

function serializeFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.end ? f.br : '');
}

// Split a JSON insert new_str into lines: split at \n, one trailing \r removed
// per line, no empty piece after a final \n; an empty string has no lines.
function splitNewStrLines(s) {
  if (s === '') return [];
  const parts = s.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (s.endsWith('\n')) parts.pop();
  return parts;
}

function rstripWs(s) {
  return s.replace(/[ \t]+$/, '');
}

function stripWs(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// Single-line equality at a matching tier (section 5).
function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

// All start positions where oldLines occur in lines at a tier.
function occurrences(lines, oldLines, tier) {
  const out = [];
  const k = oldLines.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; only 0 when strict) with an occurrence.
function firstTierWith(lines, oldLines, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, oldLines, t);
    if (pos.length > 0) return { tier: t, pos: pos };
  }
  return null;
}

// Tier-2 re-indentation of one non-context new line (section 5).
function reindentLine(line, p, f) {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

// Build the replacement lines for a matched hunk/chunk.
// oLines/nLines are arrays of {text, ctx}; context lines take the file's own
// matched line; other new lines are re-indented at tier 2, as-is otherwise.
function buildReplacement(oLines, nLines, fileLines, occStart, tier) {
  const oCtx = [];
  for (let i = 0; i < oLines.length; i++) if (oLines[i].ctx) oCtx.push(i);
  const f = occStart < fileLines.length ? leadingWs(fileLines[occStart]) : '';
  const p = oLines.length > 0 ? leadingWs(oLines[0].text) : '';
  const out = [];
  let cj = 0;
  for (let k = 0; k < nLines.length; k++) {
    const nl = nLines[k];
    if (nl.ctx) {
      out.push(fileLines[occStart + oCtx[cj]]);
      cj++;
    } else {
      let t = nl.text;
      if (tier === 2) t = reindentLine(t, p, f);
      out.push(t);
    }
  }
  return out;
}

// Compare two strings in UTF-8 byte order.
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Invocation (section 1)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return { ok: false };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return { ok: false };
        }
        format = v;
      } else if (a === '--check') {
        if (seenCheck) return { ok: false };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { ok: false };
        seenStrict = true;
        strict = true;
      } else {
        return { ok: false };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { ok: false };
  return {
    ok: true,
    format: format,
    check: check,
    strict: strict,
    patch: positional.length === 1 ? positional[0] : null,
  };
}

// ---------------------------------------------------------------------------
// Format detection (section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines) {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (let k = 0; k < lines.length; k++) {
    if (rstripWs(lines[k]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

// Path from a --- / +++ header line: text after the four characters, up to the
// first tab, surrounding spaces removed; a leading a/ or b/ is removed.
function parsePatchPath(line) {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseDiffGit(line, idx) {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw { parseLine: idx + 1 };
  const j = rest.indexOf(' b/', 2);
  if (j < 0) throw { parseLine: idx + 1 };
  const x = rest.slice(2, j);
  const y = rest.slice(j + 3).trim();
  if (x === '' || y === '') throw { parseLine: idx + 1 };
  return { x: x, y: y };
}

// O/N lines of a hunk body, plus whether a \ line follows the hunk's last
// context or + line.
function hunkON(body) {
  const o = [];
  const n = [];
  let lastCtxNew = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k];
    if (l === '' || l[0] === ' ' || l[0] === '+') lastCtxNew = k;
  }
  let noNl = false;
  if (lastCtxNew >= 0 && lastCtxNew + 1 < body.length && body[lastCtxNew + 1][0] === '\\') {
    noNl = true;
  }
  for (const l of body) {
    if (l === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
    } else if (l[0] === ' ') {
      o.push({ text: l.slice(1), ctx: true });
      n.push({ text: l.slice(1), ctx: true });
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false });
    }
    // a \ line refers to the body line before it; it adds no line itself.
  }
  return { o: o, n: n, noNl: noNl };
}

// Whether a created file ends with a line break: it does unless a \ line
// follows its last + line.
function creationEndsWithBreak(hunks) {
  let last = null;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k][0] === '+') last = { h: h, idx: k };
    }
  }
  if (!last) return true;
  const b = last.h.body;
  if (last.idx + 1 < b.length && b[last.idx + 1][0] === '\\') return false;
  return true;
}

function parseUnified(lines) {
  const sections = [];
  const n = lines.length;
  let cur = null;
  function startSection(diffX, diffY) {
    cur = {
      oldPath: undefined,
      newPath: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      delFile: false,
      diffX: diffX,
      diffY: diffY,
      pairSeen: false,
      hunks: [],
      state: 'header',
    };
    sections.push(cur);
  }
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const g = parseDiffGit(line, i);
        startSection(g.x, g.y);
        i++;
        continue;
      }
      if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        startSection(undefined, undefined);
        continue;
      }
      if (line.startsWith('@@')) throw { parseLine: i + 1 };
      i++;
      continue;
    }
    if (cur.state === 'header') {
      if (line.startsWith('@@')) {
        parseHunk(lines, i, cur);
        i = parseHunk.next;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const g = parseDiffGit(line, i);
        startSection(g.x, g.y);
        i++;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          if (cur.pairSeen) {
            startSection(undefined, undefined);
            continue;
          }
          const op = parsePatchPath(line);
          cur.oldPath = op === '/dev/null' ? null : op;
          const np = parsePatchPath(lines[i + 1]);
          cur.newPath = np === '/dev/null' ? null : np;
          cur.pairSeen = true;
          i += 2;
          continue;
        }
        throw { parseLine: i + 2 };
      }
      if (line.startsWith('+++ ')) {
        const np2 = parsePatchPath(line);
        cur.newPath = np2 === '/dev/null' ? null : np2;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // state 'after': between hunks, or after the last hunk.
    if (line.startsWith('@@')) {
      parseHunk(lines, i, cur);
      i = parseHunk.next;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line, i);
      startSection(g.x, g.y);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      startSection(undefined, undefined);
      continue;
    }
    i++;
  }
  return sections;
}

// Parse one hunk starting at lines[i] (a @@ line); appends to section.
// Sets parseHunk.next to the index of the first line after the hunk body.
function parseHunk(lines, i, section) {
  const line = lines[i];
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw { parseLine: i + 1 };
  const a = parseInt(m[1], 10);
  const n = lines.length;
  let j = i + 1;
  const body = [];
  while (j < n) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  section.hunks.push({ a: a, body: body });
  section.state = 'after';
  parseHunk.next = j;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines) {
  const blocks = [];
  const n = lines.length;
  let prevReplace = 0; // index just after the previous block's REPLACE line
  let prevPath = null;
  let i = 0;
  while (i < n) {
    if (rstripWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let p = null;
    for (let j = s - 1; j >= prevReplace; j--) {
      const t = lines[j];
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      p = t.trim();
      break;
    }
    if (p === null) {
      if (prevPath !== null) p = prevPath;
      else throw { parseLine: s + 1 };
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (rstripWs(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw { parseLine: s + 1 };
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (rstripWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw { parseLine: s + 1 };
    blocks.push({
      path: p,
      oldLines: lines.slice(s + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = p;
    prevReplace = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

function parseV4a(lines) {
  const n = lines.length;
  let first = -1;
  for (let k = 0; k < n; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) throw { parseLine: 1 };
  if (lines[first].trim() !== '*** Begin Patch') throw { parseLine: first + 1 };
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw { parseLine: n + 1 };
  const sections = [];
  const end = last; // exclusive: lines[end] is *** End Patch
  let i = first + 1;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const raw = [];
      while (i < end) {
        const l = lines[i];
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        raw.push({ text: l, idx: i });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      const fileLines = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw { parseLine: r.idx + 1 };
      }
      sections.push({ action: 'add', path: p, lines: fileLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      const raw = [];
      while (i < end) {
        const l = lines[i];
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        raw.push({ text: l, idx: i });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      if (raw.length > 0) throw { parseLine: raw[0].idx + 1 };
      sections.push({ action: 'delete', path: p });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateIdx = i;
      i++;
      let moveTo = null;
      let j = i;
      while (j < end && lines[j].trim() === '') j++;
      if (j < end && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j++;
      }
      i = j;
      const chunks = [];
      let cur = null;
      function closeChunk() {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      }
      while (i < end) {
        const l = lines[i];
        if (l.trim() === '') {
          if (cur) {
            cur.body.push(l);
            i++;
            continue;
          }
          i++;
          continue;
        }
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        if (l === '*** End of File') {
          if (!cur) throw { parseLine: i + 1 };
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          i++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!cur) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
            } else {
              throw { parseLine: i + 1 };
            }
          }
          cur.body.push(l);
          i++;
          continue;
        }
        throw { parseLine: i + 1 };
      }
      if (cur) closeChunk();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (
          lastChunk.body.length > 0 &&
          lastChunk.body[lastChunk.body.length - 1].trim() === ''
        ) {
          lastChunk.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        throw { parseLine: updateIdx + 1 };
      }
      sections.push({ action: 'update', path: p, moveTo: moveTo, chunks: chunks });
      continue;
    }
    throw { parseLine: i + 1 };
  }
  return sections;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(el, lineNo) {
  if (el === null || typeof el !== 'object' || Array.isArray(el)) {
    throw { parseLine: lineNo };
  }
  if (typeof el.path !== 'string') throw { parseLine: lineNo };
  if (typeof el.command !== 'string') throw { parseLine: lineNo };
  if (el.command === 'create') {
    if (typeof el.file_text !== 'string') throw { parseLine: lineNo };
    return { command: 'create', path: el.path, file_text: el.file_text };
  }
  if (el.command === 'str_replace') {
    if (typeof el.old_str !== 'string' || el.old_str === '') throw { parseLine: lineNo };
    let ns = '';
    if ('new_str' in el) {
      if (typeof el.new_str !== 'string') throw { parseLine: lineNo };
      ns = el.new_str;
    }
    return { command: 'str_replace', path: el.path, old_str: el.old_str, new_str: ns };
  }
  if (el.command === 'insert') {
    if (!Number.isInteger(el.insert_line)) throw { parseLine: lineNo };
    if (typeof el.new_str !== 'string') throw { parseLine: lineNo };
    return {
      command: 'insert',
      path: el.path,
      insert_line: el.insert_line,
      new_str: el.new_str,
    };
  }
  throw { parseLine: lineNo };
}

function parseJson(patchLines, patchText) {
  let first = -1;
  for (let k = 0; k < patchLines.length; k++) {
    if (patchLines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) return [];
  const firstCh = patchLines[first].trimStart()[0];
  if (firstCh === '[') {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw { parseLine: first + 1 };
    }
    if (!Array.isArray(arr)) throw { parseLine: first + 1 };
    const edits = [];
    for (const el of arr) {
      edits.push(validateJsonEdit(el, first + 1));
    }
    return edits;
  }
  const edits = [];
  for (let k = 0; k < patchLines.length; k++) {
    const l = patchLines[k];
    if (l.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      throw { parseLine: k + 1 };
    }
    edits.push(validateJsonEdit(obj, k + 1));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Patch dispatch
// ---------------------------------------------------------------------------

// Returns the list of edits (each {type, ...}); throws {parseLine} on a
// parse fault. An empty list means the reader found no edit at all.
function parsePatch(format, patchLines, patchText) {
  if (format === 'unified') {
    const sections = parseUnified(patchLines);
    return sections.map((s) => ({ type: 'unified', section: s }));
  }
  if (format === 'search-replace') {
    const blocks = parseSearchReplace(patchLines);
    return blocks.map((b) => ({ type: 'sr', block: b }));
  }
  if (format === 'v4a') {
    const sections = parseV4a(patchLines);
    return sections.map((s) => ({ type: 'v4a', section: s }));
  }
  const edits = parseJson(patchLines, patchText);
  return edits.map((e) => ({ type: 'json', edit: e }));
}

// ---------------------------------------------------------------------------
// Applying edits (sections 2, 5-10)
// ---------------------------------------------------------------------------

function fail(code, p) {
  return { fail: { code: code, path: p } };
}

function applyUnified(edit, tree, strict) {
  const s = edit.section;
  let oldP =
    s.oldPath !== undefined
      ? s.oldPath
      : s.renameFrom !== undefined
        ? s.renameFrom
        : s.diffX !== undefined
          ? s.diffX
          : undefined;
  let newP =
    s.newPath !== undefined
      ? s.newPath
      : s.renameTo !== undefined
        ? s.renameTo
        : s.diffY !== undefined
          ? s.diffY
          : undefined;
  if (oldP === undefined && newP !== undefined) oldP = newP;
  if (newP === undefined && oldP !== undefined) newP = oldP;
  if (oldP === undefined) oldP = '';
  if (newP === undefined) newP = '';
  let action;
  if (s.newFile || oldP === null) action = 'create';
  else if (s.delFile || newP === null) action = 'delete';
  else if (oldP !== newP) action = 'move';
  else action = 'change';
  const paths = [];
  if (action === 'create') paths.push(newP);
  else if (action === 'delete') paths.push(oldP);
  else if (action === 'move') {
    paths.push(oldP);
    paths.push(newP);
  } else paths.push(oldP);
  for (const p of paths) {
    if (!isSafePath(p)) return fail('unsafe', p);
  }
  if (action === 'create') {
    if (tree.has(newP)) return fail('exists', newP);
    const plus = [];
    for (const h of s.hunks) {
      for (const l of h.body) {
        if (l[0] === '+') plus.push(l.slice(1));
      }
    }
    let content = '';
    if (plus.length > 0) {
      content = plus.join('\n') + (creationEndsWithBreak(s.hunks) ? '\n' : '');
    }
    tree.set(newP, content);
    return {};
  }
  if (action === 'delete') {
    if (!tree.has(oldP)) return fail('missing', oldP);
    tree.delete(oldP);
    return {};
  }
  if (!tree.has(oldP)) return fail('missing', oldP);
  if (action === 'move' && tree.has(newP)) return fail('exists', newP);
  const f = parseFileText(tree.get(oldP));
  let d = 0;
  for (const h of s.hunks) {
    const on = hunkON(h.body);
    const o = on.o;
    const n = on.n;
    if (o.length === 0) {
      const ins = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = ins === f.lines.length;
      const rep = n.map((x) => x.text);
      f.lines.splice(ins, 0, ...rep);
      if (atEnd) f.end = !on.noNl;
      d += n.length - o.length;
    } else {
      const found = firstTierWith(
        f.lines,
        o.map((x) => x.text),
        strict
      );
      if (!found) return fail('no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === f.lines.length;
      const rep = buildReplacement(o, n, f.lines, best, found.tier);
      f.lines.splice(best, o.length, ...rep);
      if (atEnd) f.end = !on.noNl;
      d += n.length - o.length;
    }
  }
  const content = serializeFile(f);
  if (action === 'move') {
    tree.delete(oldP);
    tree.set(newP, content);
    return { move: { old: oldP, new: newP } };
  }
  tree.set(oldP, content);
  return {};
}

function applySR(edit, tree, strict) {
  const b = edit.block;
  const p = b.path;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.has(p)) return fail('exists', p);
    const content = b.newLines.length > 0 ? b.newLines.join('\n') + '\n' : '';
    tree.set(p, content);
    return {};
  }
  if (!tree.has(p)) return fail('missing', p);
  const f = parseFileText(tree.get(p));
  const found = firstTierWith(f.lines, b.oldLines, strict);
  if (!found) return fail('no-match', p);
  if (found.pos.length > 1) return fail('ambiguous', p);
  const occ = found.pos[0];
  let rep;
  if (found.tier === 2) {
    const F = leadingWs(f.lines[occ]);
    const P = leadingWs(b.oldLines[0]);
    rep = b.newLines.map((l) => reindentLine(l, P, F));
  } else {
    rep = b.newLines.slice();
  }
  f.lines.splice(occ, b.oldLines.length, ...rep);
  tree.set(p, serializeFile(f));
  return {};
}

function applyV4a(edit, tree, strict) {
  const s = edit.section;
  const p = s.path;
  const paths = [p];
  if (s.action === 'update' && s.moveTo) paths.push(s.moveTo);
  for (const x of paths) {
    if (!isSafePath(x)) return fail('unsafe', x);
  }
  if (s.action === 'add') {
    if (tree.has(p)) return fail('exists', p);
    const content = s.lines.length > 0 ? s.lines.join('\n') + '\n' : '';
    tree.set(p, content);
    return {};
  }
  if (s.action === 'delete') {
    if (!tree.has(p)) return fail('missing', p);
    tree.delete(p);
    return {};
  }
  if (!tree.has(p)) return fail('missing', p);
  if (s.moveTo && tree.has(s.moveTo)) return fail('exists', s.moveTo);
  const f = parseFileText(tree.get(p));
  let cursor = 0;
  for (const ch of s.chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      let foundIdx = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (lineEq(f.lines[k], ch.anchor, t)) {
            foundIdx = k;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) return fail('no-match', p);
      cursor = foundIdx + 1;
    }
    const o = [];
    const n = [];
    for (const l of ch.body) {
      if (l === '') {
        o.push({ text: '', ctx: true });
        n.push({ text: '', ctx: true });
      } else if (l[0] === ' ') {
        o.push({ text: l.slice(1), ctx: true });
        n.push({ text: l.slice(1), ctx: true });
      } else if (l[0] === '-') {
        o.push({ text: l.slice(1), ctx: false });
      } else if (l[0] === '+') {
        n.push({ text: l.slice(1), ctx: false });
      }
    }
    if (o.length === 0) {
      const ins = ch.eof ? f.lines.length : cursor;
      const rep = n.map((x) => x.text);
      f.lines.splice(ins, 0, ...rep);
      cursor = ins + rep.length;
    } else {
      const oText = o.map((x) => x.text);
      const tiers = strict ? [0] : [0, 1, 2];
      let found = null;
      for (const t of tiers) {
        const pos = occurrences(f.lines, oText, t).filter(
          (idx) => idx >= cursor && (!ch.eof || idx + oText.length - 1 === f.lines.length - 1)
        );
        if (pos.length > 0) {
          found = { tier: t, pos: pos[0] };
          break;
        }
      }
      if (!found) return fail('no-match', p);
      const rep = buildReplacement(o, n, f.lines, found.pos, found.tier);
      f.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + rep.length;
    }
  }
  const content = serializeFile(f);
  if (s.moveTo) {
    tree.delete(p);
    tree.set(s.moveTo, content);
    return { move: { old: p, new: s.moveTo } };
  }
  tree.set(p, content);
  return {};
}

function applyJson(edit, tree) {
  const e = edit.edit;
  const p = e.path;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (e.command === 'create') {
    if (tree.has(p)) return fail('exists', p);
    tree.set(p, e.file_text);
    return {};
  }
  if (e.command === 'str_replace') {
    if (!tree.has(p)) return fail('missing', p);
    const text = tree.get(p);
    const f = parseFileText(text);
    let hay = text;
    let oldS = e.old_str;
    let newS = e.new_str;
    if (f.br === '\r\n') {
      hay = text.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstIdx = -1;
    let from = 0;
    while (true) {
      const ix = hay.indexOf(oldS, from);
      if (ix < 0) break;
      if (count === 0) firstIdx = ix;
      count++;
      if (count > 1) break;
      from = ix + 1;
    }
    if (count === 0) return fail('no-match', p);
    if (count > 1) return fail('ambiguous', p);
    let res = hay.slice(0, firstIdx) + newS + hay.slice(firstIdx + oldS.length);
    if (f.br === '\r\n') res = res.replace(/\n/g, '\r\n');
    tree.set(p, res);
    return {};
  }
  if (!tree.has(p)) return fail('missing', p);
  const f = parseFileText(tree.get(p));
  if (e.insert_line < 0 || e.insert_line > f.lines.length) {
    return fail('no-match', p);
  }
  const ins = splitNewStrLines(e.new_str);
  f.lines.splice(e.insert_line, 0, ...ins);
  tree.set(p, serializeFile(f));
  return {};
}

function applyEdit(edit, tree, strict) {
  if (edit.type === 'unified') return applyUnified(edit, tree, strict);
  if (edit.type === 'sr') return applySR(edit, tree, strict);
  if (edit.type === 'v4a') return applyV4a(edit, tree, strict);
  return applyJson(edit, tree);
}

// ---------------------------------------------------------------------------
// Tree I/O and the change report (section 2)
// ---------------------------------------------------------------------------

function readTree(dir) {
  const out = new Map();
  function walk(d, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          out.set(rel, fs.readFileSync(full, 'utf-8'));
        } catch {
          // unreadable entries are not part of the tree
        }
      }
    }
  }
  walk(dir, '');
  return out;
}

function writeTree(before, after) {
  for (const [p, text] of after) {
    if (before.get(p) !== text) {
      const dir = path.dirname(p);
      if (dir !== '.') fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, text, 'utf-8');
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    }
  }
}

// Lines for exit 0: one per changed path in UTF-8 byte order, then ok: n.
function changeReport(before, after, moves) {
  const added = new Set();
  const deleted = new Set();
  const modified = new Set();
  for (const [p, text] of after) {
    if (!before.has(p)) added.add(p);
    else if (before.get(p) !== text) modified.add(p);
  }
  for (const p of before.keys()) {
    if (!after.has(p)) deleted.add(p);
  }
  const rLines = [];
  for (const m of moves) {
    if (deleted.has(m.old) && added.has(m.new)) {
      deleted.delete(m.old);
      added.delete(m.new);
      rLines.push({ key: m.new, text: 'R ' + m.old + ' -> ' + m.new });
    }
  }
  const lines = [];
  for (const p of added) lines.push({ key: p, text: 'A ' + p });
  for (const p of deleted) lines.push({ key: p, text: 'D ' + p });
  for (const p of modified) lines.push({ key: p, text: 'M ' + p });
  for (const r of rLines) lines.push(r);
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    out('error: usage');
    process.exitCode = 2;
    return;
  }
  let patchText;
  if (parsed.patch === null || parsed.patch === '-') {
    patchText = fs.readFileSync(0, 'utf-8');
  } else {
    try {
      patchText = fs.readFileSync(parsed.patch, 'utf-8');
    } catch {
      out('error: no-patch');
      process.exitCode = 2;
      return;
    }
  }
  const patchLines = splitPatchLines(patchText);
  let format = parsed.format;
  if (format === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      out('error: format');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits;
  try {
    edits = parsePatch(format, patchLines, patchText);
  } catch (e) {
    if (e && typeof e.parseLine === 'number') {
      out('error: parse ' + e.parseLine);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    out('error: parse 1');
    process.exitCode = 2;
    return;
  }
  const before = readTree('.');
  const tree = new Map(before);
  const failures = [];
  const moves = [];
  for (const edit of edits) {
    const r = applyEdit(edit, tree, parsed.strict);
    if (r && r.fail) failures.push(r.fail);
    else if (r && r.move) moves.push(r.move);
  }
  if (failures.length > 0) {
    for (const f of failures) out('error: ' + f.code + ' ' + f.path);
    out('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    process.exitCode = 1;
    return;
  }
  const lines = changeReport(before, tree, moves);
  for (const l of lines) out(l);
  if (lines.length === 1) out('ok: 1 file');
  else out('ok: ' + lines.length + ' files');
  if (!parsed.check) writeTree(before, tree);
  process.exitCode = 0;
}

main();

