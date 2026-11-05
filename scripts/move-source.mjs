/**
 * Reading Move source for the guard scripts: check-core-no-balance,
 * check-spend-permits, check-compliance-subtractive and check-abort-codes.
 *
 * The guards are source scanners, not a compiler. This module is the part of
 * them that decides what counts as code, so each guard can say exactly what it
 * sees. It does three things and no more:
 *
 *   maskMove   Comments and the bytes inside string literals become spaces.
 *              Every offset and every newline is kept, so a line number found
 *              in the masked text is the line in the file. It follows the Move
 *              lexer: a line comment runs to the end of its line; block
 *              comments NEST (Sui CLI 1.82.3 compiles a block comment that
 *              contains another one); a string is b"…", x"…" or an attribute's
 *              "…", and a backslash escapes the next character. So b"//" and
 *              b"/*" are strings, not comments, and nothing after them is
 *              hidden. Source this cannot lex (a comment or string that never
 *              closes) throws, and the guard fails rather than guess.
 *
 *   moveFiles  Every .move file under a directory, recursively, the way the
 *              compiler reads sources/.
 *
 *   functions, datatypes, uses, modules, calls
 *              Declarations and calls found by keyword wherever they sit:
 *              after an attribute on the same line, on one line or across
 *              many. Brackets are matched, so a body is the whole body.
 *
 * It does no name resolution and no type checking. A guard that needs to know
 * what a name refers to has to forbid the forms it cannot follow (`use … as`,
 * `use fun`) rather than assume them away.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export class MoveLexError extends Error {}

/** 1-based line of `index` in `text`. */
export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** `source` with comments and string contents blanked, offsets and newlines kept. */
export function maskMove(source, file = 'source') {
  const out = source.split('');
  const n = source.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) throw new MoveLexError(`${file}:${lineOf(source, i)}: a block comment never closes`);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      if (j >= n) throw new MoveLexError(`${file}:${lineOf(source, i)}: a string literal never closes`);
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every .move file under `dir`, recursively, sorted. Throws if `dir` is unreadable. */
export function moveFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...moveFiles(full));
    else if (entry.name.endsWith('.move')) files.push(full);
  }
  return files.sort();
}

/** Read and mask one file: `{ file, raw, code }`. */
export function readMove(file) {
  const raw = readFileSync(file, 'utf8');
  return { file, raw, code: maskMove(raw, file) };
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Index of the bracket that closes the one at `open` (any of ( [ {), or -1. */
export function closing(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (OPENERS.includes(c)) depth += 1;
    else if (CLOSERS.includes(c)) {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Index of the `>` that closes a type-argument list opened at `open`, or -1
 * when what follows is not a type list (a `<` comparison, say). Only the
 * characters a type list can hold are allowed between the brackets.
 */
export function angleClose(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '<') depth += 1;
    else if (c === '>') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (!/[\w\s:,&+$]/.test(c)) return -1;
  }
  return -1;
}

function skipSpace(code, i) {
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
}

/**
 * Split `code[start, end)` at top-level commas. Parentheses, brackets, braces
 * and type-argument lists (a `<` right after a name) are kept whole.
 * Returns `[{ text, start, end }]`, trimmed, empty items dropped.
 */
export function splitTopLevel(code, start, end) {
  const items = [];
  let depth = 0;
  let from = start;
  const push = (to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(code[a])) a += 1;
    while (b > a && /\s/.test(code[b - 1])) b -= 1;
    if (b > a) items.push({ text: code.slice(a, b), start: a, end: b });
  };
  for (let i = start; i < end; i += 1) {
    const c = code[i];
    if (c === '<' && depth === 0 && /[\w>]\s*$/.test(code.slice(Math.max(start, i - 64), i))) {
      const close = angleClose(code, i);
      if (close !== -1 && close < end) {
        i = close;
        continue;
      }
    }
    if (OPENERS.includes(c)) depth += 1;
    else if (CLOSERS.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(end);
  return items;
}

/** `T: store + drop, phantom U` into `[{ name, phantom, constraints }]`. */
function typeParameters(text) {
  if (!text) return [];
  const inner = text.slice(1, -1);
  return splitTopLevel(inner, 0, inner.length).map(({ text: item }) => {
    const phantom = /^phantom\s+/.test(item);
    const rest = item.replace(/^phantom\s+/, '');
    const [name, constraints = ''] = rest.split(':');
    return {
      name: name.trim(),
      phantom,
      constraints: new Set(constraints.split('+').map((s) => s.trim()).filter(Boolean)),
    };
  });
}

/**
 * Every function, macro and native function: its name, visibility
 * ('' | 'public' | 'public(package)' | 'public(friend)'), whether it is
 * entry / macro / native, its type parameters, parameter text, return text
 * and body (braces included; '' for native), with offsets.
 */
export function functions(code) {
  const out = [];
  for (const m of code.matchAll(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const before = code.slice(Math.max(0, m.index - 200), m.index);
    if (/\buse\s+$/.test(before)) continue; // `use fun f as T.m;`
    const mods = /((?:\b(?:public(?:\s*\(\s*\w+\s*\))?|entry|macro|native)\s+)*)$/.exec(before)[1];
    let vis = '';
    if (/\bpublic\b/.test(mods)) {
      const scoped = /\bpublic\s*\(\s*(\w+)\s*\)/.exec(mods);
      vis = scoped ? `public(${scoped[1]})` : 'public';
    }
    let i = skipSpace(code, m.index + m[0].length);
    let generics = '';
    if (code[i] === '<') {
      const close = angleClose(code, i);
      if (close === -1) continue;
      generics = code.slice(i, close + 1);
      i = skipSpace(code, close + 1);
    }
    if (code[i] !== '(') continue;
    const paramsEnd = closing(code, i);
    if (paramsEnd === -1) continue;
    const params = code.slice(i + 1, paramsEnd);
    let j = paramsEnd + 1;
    while (j < code.length && code[j] !== '{' && code[j] !== ';') j += 1;
    const returns = code.slice(paramsEnd + 1, j).replace(/^\s*:\s*/, '').trim();
    let body = '';
    let bodyStart = -1;
    let bodyEnd = j;
    if (code[j] === '{') {
      bodyStart = j;
      bodyEnd = closing(code, j);
      if (bodyEnd === -1) continue;
      body = code.slice(j, bodyEnd + 1);
    }
    out.push({
      name: m[1],
      visibility: vis,
      entry: /\bentry\b/.test(mods),
      macro: /\bmacro\b/.test(mods),
      native: /\bnative\b/.test(mods),
      generics,
      typeParameters: typeParameters(generics),
      params,
      paramsStart: i + 1,
      returns,
      body,
      index: m.index,
      start: m.index - mods.length,
      bodyStart,
      bodyEnd,
    });
  }
  return out;
}

/** `name: type` pairs of a parameter list. */
export function parameters(params) {
  return splitTopLevel(params, 0, params.length).map(({ text }) => {
    const colon = text.indexOf(':');
    return colon === -1
      ? { name: '', type: text.trim() }
      : { name: text.slice(0, colon).replace(/^mut\s+/, '').trim(), type: text.slice(colon + 1).trim() };
  });
}

function abilityList(code, i) {
  const m = /^has\b([\s\w,]*)/.exec(code.slice(i));
  if (!m) return { abilities: [], next: i };
  return {
    abilities: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    next: i + m[0].length,
  };
}

/**
 * Every struct and enum: named-field, positional and variant bodies alike.
 * `{ kind, name, typeParameters, abilities, body, index, end }`, where body is
 * everything between the outer brackets (all variants, for an enum) and
 * abilities joins a prefix `has` and a postfix one.
 */
export function datatypes(code) {
  const out = [];
  for (const m of code.matchAll(/\b(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    let i = skipSpace(code, m.index + m[0].length);
    let generics = '';
    if (code[i] === '<') {
      const close = angleClose(code, i);
      if (close === -1) continue;
      generics = code.slice(i, close + 1);
      i = skipSpace(code, close + 1);
    }
    const prefix = abilityList(code, i);
    i = skipSpace(code, prefix.next);
    let body = '';
    let end = i;
    if (code[i] === '{' || code[i] === '(') {
      const close = closing(code, i);
      if (close === -1) continue;
      body = code.slice(i + 1, close);
      end = close + 1;
    }
    const postfix = abilityList(code, skipSpace(code, end));
    if (postfix.abilities.length) end = postfix.next;
    out.push({
      kind: m[1],
      name: m[2],
      typeParameters: typeParameters(generics),
      abilities: new Set([...prefix.abilities, ...postfix.abilities]),
      body,
      index: m.index,
      end,
    });
  }
  return out;
}

/**
 * Every `use` declaration, flattened: `{ index, fun, path, alias, local }`.
 * `use sui::balance::{Self, Balance as Ledger};` is two entries: path
 * 'sui::balance' with local 'balance', and path 'sui::balance::Balance' with
 * alias and local 'Ledger'. Nested groups are flattened. `use fun …` is one
 * entry with fun set and the declaration's text as path.
 */
export function uses(code) {
  const out = [];
  for (const m of code.matchAll(/\buse\s+/g)) {
    const semi = code.indexOf(';', m.index);
    if (semi === -1) continue;
    const text = code.slice(m.index + m[0].length, semi).replace(/\s+/g, ' ').trim();
    if (/^fun\b/.test(text)) {
      out.push({ index: m.index, fun: true, path: text, alias: null, local: null });
      continue;
    }
    const walk = (prefix, tree) => {
      const t = tree.trim();
      const brace = t.indexOf('{');
      if (brace !== -1) {
        const head = t.slice(0, brace).replace(/::\s*$/, '').trim();
        const inner = t.slice(brace + 1, t.lastIndexOf('}'));
        const base = prefix ? `${prefix}::${head}` : head;
        for (const item of splitTopLevel(inner, 0, inner.length)) walk(base, item.text);
        return;
      }
      const [target, alias] = t.split(/\s+as\s+/).map((s) => s.trim());
      const full = target === 'Self' ? prefix : prefix ? `${prefix}::${target}` : target;
      const local = alias ?? full.split('::').at(-1);
      out.push({ index: m.index, fun: false, path: full.replace(/\s+/g, ''), alias: alias ?? null, local });
    };
    walk('', text);
  }
  return out;
}

/** Every `module address::name` declaration, in order: `{ address, name, index }`. */
export function modules(code) {
  return [...code.matchAll(/\bmodule\s+([A-Za-z0-9_]+)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => ({
    address: m[1],
    name: m[2],
    index: m.index,
  }));
}

/**
 * Every call whose callee matches `callee` (a regex source; it must not be
 * preceded by a name character, `:` or `.`): `{ index, callee, typeArgs,
 * args, end }`, with typeArgs `{ start, end }` around the brackets (or null)
 * and args as splitTopLevel returns them.
 */
export function calls(code, callee) {
  const out = [];
  const re = new RegExp(`(?<![\\w:.])(${callee})`, 'g');
  for (const m of code.matchAll(re)) {
    let i = skipSpace(code, m.index + m[0].length);
    let typeArgs = null;
    if (code[i] === '<') {
      const close = angleClose(code, i);
      if (close === -1) continue;
      typeArgs = { start: i, end: close + 1 };
      i = skipSpace(code, close + 1);
    }
    if (code[i] !== '(') continue;
    const close = closing(code, i);
    if (close === -1) continue;
    out.push({ index: m.index, callee: m[1], typeArgs, args: splitTopLevel(code, i + 1, close), end: close + 1 });
  }
  return out;
}

/** Offsets of every whole-word occurrence of `name`. */
export function tokens(code, name) {
  return [...code.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w])`, 'g'))].map((m) => m.index);
}

/** The function whose body contains `index`, or null. */
export function enclosing(fns, index) {
  return fns.find((f) => f.bodyStart !== -1 && index > f.bodyStart && index < f.bodyEnd) ?? null;
}

/** Text with whitespace removed, for comparing expressions. */
export function squash(text) {
  return text.replace(/\s+/g, '');
}
