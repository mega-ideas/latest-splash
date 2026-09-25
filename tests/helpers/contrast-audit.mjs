/**
 * Measures what a page's words, icons and text fields look like against what
 * they sit on, from its TSX and the app's stylesheet, without a browser.
 *
 * WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3:1 for icons and for the edge that
 * identifies a field (1.4.11). Text set below 12px is reported too.
 *
 * It follows a page from its entry files through every component it imports,
 * and resolves class names through conditions, lookup tables, helper
 * functions, `cn()` and `cva()`. It knows where each element is painted: its
 * JSX parent, the `{children}` slot of a wrapper component, where a component
 * is rendered, and the layout that renders a Next.js page. Colours come from
 * Tailwind utilities (arbitrary values, theme names, the default palette), the
 * app's own CSS rules (with their cascade: unlayered rules beat Tailwind's
 * layers, !important beats both) and inline styles. Variables are resolved in
 * the scope of the element, and `color-mix()`, `oklch()` and gradients are
 * computed. Translucent colours are blended over what is under them, and
 * contrast is WCAG relative luminance.
 *
 * Where it cannot know, it errs towards checking more: every alternative a
 * condition can choose, every place a component is rendered, every stop of a
 * linear gradient. A colour it cannot resolve (one passed in at runtime) is
 * counted and left out rather than guessed, and so is a radial or conic glow,
 * whose position the source does not give.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const requireFromRoot = createRequire(join(ROOT, 'package.json'));

export const WORDS = 4.5;
export const NON_TEXT = 3;
export const SMALLEST_PX = 12;

// ── Colour ──────────────────────────────────────────────────────────────────

/** A paint is `[r, g, b, alpha]`; a colour is an opaque `[r, g, b]`. */
export const over = ([r, g, b, alpha], under) => [r, g, b].map((c, i) => alpha * c + (1 - alpha) * under[i]);

export function luminance(colour) {
  const [r, g, b] = colour.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export const hex = (colour) =>
  `#${colour.slice(0, 3).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v)) * 255;
  });
}

/** Split at top level (outside brackets and quotes) on any of `separators`. */
export function splitTop(text, separators = [',']) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && separators.includes(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

function hexPaint(text) {
  let digits = text.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(digits)) return null;
  const rgb = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  return [...rgb, digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1];
}

const fraction = (text) => (text === undefined ? 1 : text.trim().endsWith('%') ? parseFloat(text) / 100 : parseFloat(text));

/**
 * Every paint a CSS value can put down: one for a colour, one per stop for a
 * gradient, one per layer. `current` when it uses the text colour, `unknown`
 * when some of it could not be resolved.
 */
export function paintsOf(value, vars, depth = 0) {
  const out = { paints: [], current: false, unknown: false };
  if (value === undefined || value === null || depth > 16) {
    out.unknown = true;
    return out;
  }
  for (const token of splitTop(String(value).replace(/!important/gi, ''), [',', ' ', '\n', '\t'])) {
    const call = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(token);
    const lower = token.toLowerCase();
    if (call) {
      const name = call[1].toLowerCase();
      const args = call[2];
      if (name === 'var') {
        const [reference, ...fallback] = splitTop(args, [',']);
        const resolved = vars.get(reference) ?? (fallback.length ? fallback.join(',') : undefined);
        merge(out, paintsOf(resolved, vars, depth + 1));
      } else if (name.endsWith('gradient')) {
        for (const stop of splitTop(args, [','])) merge(out, paintsOf(stop, vars, depth + 1));
      } else if (name === 'url' || name === 'image-set' || name === 'calc') {
        // an image or a length: no colour
      } else {
        const paint = colourFunction(name, args, vars, depth);
        if (paint) out.paints.push(paint);
        else out.unknown = true;
      }
    } else if (lower === 'currentcolor') out.current = true;
    else if (lower in NAMED) out.paints.push(NAMED[lower]);
    else if (token.startsWith('#')) {
      const paint = hexPaint(token);
      if (paint) out.paints.push(paint);
      else out.unknown = true;
    }
    // Anything else is a keyword or a length: no colour.
  }
  return out;
}

function merge(into, from) {
  into.paints.push(...from.paints);
  into.current ||= from.current;
  into.unknown ||= from.unknown;
}

/** The one paint a colour value resolves to, or null. */
function onePaint(value, vars, depth) {
  const { paints, unknown, current } = paintsOf(value, vars, depth + 1);
  return paints.length === 1 && !unknown && !current ? paints[0] : null;
}

function colourFunction(name, args, vars, depth) {
  if (name === 'rgb' || name === 'rgba') {
    const [main, slash] = args.split('/');
    const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
    const channel = (v) => (v.trim().endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const [r, g, b, a] = parts;
    return [channel(r), channel(g), channel(b), fraction(slash ?? a)];
  }
  if (name === 'oklch') {
    const [main, slash] = args.split('/');
    const [l, c, h] = main.trim().split(/\s+/);
    const L = l.endsWith('%') ? parseFloat(l) / 100 : parseFloat(l);
    const C = c.endsWith('%') ? (parseFloat(c) / 100) * 0.4 : parseFloat(c);
    return [...oklchToRgb(L, C, parseFloat(h) || 0), fraction(slash)];
  }
  if (name === 'color-mix') {
    const [space, first, second] = splitTop(args, [',']);
    if (!/^in\s+srgb$/i.test(space ?? '') || !first || !second) return null;
    const side = (text) => {
      const match = /^([\s\S]*?)\s+(\d*\.?\d+)%$/.exec(text);
      return match ? { colour: match[1], share: parseFloat(match[2]) / 100 } : { colour: text, share: undefined };
    };
    const a = side(first);
    const b = side(second);
    let shareA = a.share;
    let shareB = b.share;
    if (shareA === undefined && shareB === undefined) shareA = shareB = 0.5;
    else if (shareA === undefined) shareA = 1 - shareB;
    else if (shareB === undefined) shareB = 1 - shareA;
    const paintA = onePaint(a.colour, vars, depth);
    const paintB = onePaint(b.colour, vars, depth);
    if (!paintA || !paintB) return null;
    const total = shareA + shareB;
    const wa = shareA / total;
    const wb = shareB / total;
    const alpha = paintA[3] * wa + paintB[3] * wb;
    const rgb = alpha === 0 ? [0, 0, 0] : [0, 1, 2].map((i) => (paintA[i] * paintA[3] * wa + paintB[i] * paintB[3] * wb) / alpha);
    return [...rgb, alpha * Math.min(1, total)];
  }
  return null;
}

// ── The stylesheet ──────────────────────────────────────────────────────────

const STATE_PSEUDO = new Set([
  'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'disabled', 'checked', 'invalid',
  'target', 'placeholder-shown', 'autofill', 'open', 'enabled', 'read-only', 'indeterminate', 'default',
]);

/** `.a > b.c:first-child` → [{ tag, classes, attrs, pseudo, element }, combinator, …]. Null for what this does not model. */
function parseSelector(selector) {
  const compounds = [];
  const combinators = [];
  let i = 0;
  const text = selector.trim();
  let current = { tag: null, classes: [], attrs: [], pseudo: [], element: null };
  const push = (combinator) => {
    compounds.push(current);
    combinators.push(combinator);
    current = { tag: null, classes: [], attrs: [], pseudo: [], element: null };
  };
  const readIdent = () => {
    let out = '';
    while (i < text.length) {
      const char = text[i];
      if (char === '\\') {
        out += text[i + 1];
        i += 2;
      } else if (/[\w-]/.test(char) || char.charCodeAt(0) > 127) {
        out += char;
        i += 1;
      } else break;
    }
    return out;
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '.') {
      i += 1;
      current.classes.push(readIdent());
    } else if (char === '#') return null;
    else if (char === '[') {
      // The closing bracket outside quotes: a class value can hold one, as in [class~="bg-[#1F4452]"].
      let end = i + 1;
      let quote = null;
      for (; end < text.length; end += 1) {
        if (quote) {
          if (text[end] === quote) quote = null;
        } else if (text[end] === '"' || text[end] === "'") quote = text[end];
        else if (text[end] === ']') break;
      }
      const inner = text.slice(i + 1, end);
      const match = /^([\w-]+)\s*(~=|\*=|\^=|\$=|=)?\s*["']?([^"']*)["']?$/.exec(inner.trim());
      if (!match) return null;
      current.attrs.push({ name: match[1], op: match[2] ?? null, value: match[3] });
      i = end + 1;
    } else if (char === ':') {
      const element = text[i + 1] === ':';
      i += element ? 2 : 1;
      const name = readIdent().toLowerCase();
      let args = null;
      if (text[i] === '(') {
        let depth = 0;
        const start = i;
        do {
          if (text[i] === '(') depth += 1;
          if (text[i] === ')') depth -= 1;
          i += 1;
        } while (depth > 0 && i < text.length);
        args = text.slice(start + 1, i - 1);
      }
      if (element) current.element = name;
      else current.pseudo.push({ name, args });
    } else if (char === '*') {
      current.tag = '*';
      i += 1;
    } else if (/\s|>|\+|~/.test(char)) {
      let combinator = ' ';
      while (i < text.length && /\s|>|\+|~/.test(text[i])) {
        if (text[i] !== ' ' && text[i] !== '\n') combinator = text[i];
        i += 1;
      }
      if (i < text.length) push(combinator);
    } else if (/[a-z]/i.test(char)) current.tag = readIdent().toLowerCase();
    else return null;
  }
  compounds.push(current);
  if (combinators.some((c) => c === '+' || c === '~')) return null;
  for (const compound of compounds) {
    for (const { name } of compound.pseudo) {
      if (['is', 'where', 'has', 'host', 'nth-of-type', 'dir', 'lang'].includes(name)) return null;
    }
  }
  const specificity = compounds.reduce(
    (sum, c) => sum + (c.classes.length + c.attrs.length + c.pseudo.filter((p) => p.name !== 'not').length) * 100 + (c.tag && c.tag !== '*' ? 1 : 0),
    0,
  );
  return { compounds, combinators, specificity };
}

/** Does this compound hold for an element with these tag and class tokens? */
function compoundMatches(compound, tags, classes) {
  if (compound.tag && compound.tag !== '*' && !tags.has(compound.tag)) return false;
  if (compound.classes.some((c) => !classes.has(c))) return false;
  for (const { name, op, value } of compound.attrs) {
    if (name !== 'class') return false;
    if (op === '~=' && !classes.has(value)) return false;
    if (op === '*=' && ![...classes].some((c) => c.includes(value))) return false;
    if (op === '=' || op === '^=' || op === '$=' || op === null) return false;
  }
  for (const { name } of compound.pseudo) {
    if (name === 'root' && !tags.has('html')) return false;
    if (STATE_PSEUDO.has(name)) return false;
  }
  return true;
}

/**
 * The app's stylesheet, as rules this can match: a flat list with each rule's
 * selectors, its colour, size and variable declarations, its cascade layer and
 * its order. Tailwind's theme (palette, text sizes) comes from the installed
 * package, and `@theme` blocks add to it.
 */
export function loadStyles(entry = 'app/globals.css') {
  const rules = [];
  const theme = new Map();
  let order = 0;
  const tailwindTheme = join(dirname(requireFromRoot.resolve('tailwindcss/package.json')), 'theme.css');

  const collectTheme = (node) => {
    node.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) theme.set(decl.prop, decl.value);
    });
  };

  const addRule = (selectors, decls, layer, viewport = null) => {
    const parsed = selectors.map(parseSelector).filter(Boolean);
    if (parsed.length === 0 || decls.length === 0) return;
    order += 1;
    rules.push({ selectors: parsed, text: selectors.join(', '), decls, layer, order, viewport });
  };

  const declsOf = (rule) => {
    const decls = [];
    for (const node of rule.nodes ?? []) {
      if (node.type === 'decl') decls.push({ prop: node.prop.toLowerCase(), value: node.value, important: node.important });
      if (node.type === 'atrule' && node.name === 'apply') {
        for (const token of node.params.split(/\s+/).filter(Boolean)) decls.push(...utilityDecls(parseUtility(token), theme));
      }
    }
    return decls;
  };

  const walk = (nodes, context) => {
    for (const node of nodes ?? []) {
      if (node.type === 'rule') {
        const selectors = context.parents
          ? context.parents.flatMap((parent) => node.selectors.map((s) => (s.includes('&') ? s.replaceAll('&', parent) : `${parent} ${s}`)))
          : node.selectors;
        addRule(selectors, declsOf(node), context.layer, context.viewport);
        walk(node.nodes.filter((child) => child.type !== 'decl'), { ...context, parents: selectors });
      } else if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name === 'import') {
          const target = node.params.replace(/^url\(|\)$/g, '').replace(/["';]/g, '').trim();
          if (target === 'tailwindcss') collectTheme(postcss.parse(readFileSync(tailwindTheme, 'utf8')));
          else if (target.startsWith('.')) load(resolve(dirname(context.file), target), context.layer);
        } else if (name === 'theme') collectTheme(node);
        else if (name === 'layer') walk(node.nodes, { ...context, layer: node.params.trim() });
        else if (name === 'media') {
          // A max-width query is the narrow screen, a min-width one the wide screen; the two
          // viewport states (`base`, `wide`) each take only their own. Dark, print and forced
          // colours are not the page this checks.
          const viewport = /max-width/i.test(node.params) ? 'base' : /min-width/i.test(node.params) ? 'wide' : context.viewport;
          if (!/prefers-color-scheme:\s*dark|print|forced-colors/i.test(node.params)) walk(node.nodes, { ...context, viewport });
        } else if (name === 'supports') walk(node.nodes, context);
        else if (name === 'utility') addRule([`.${node.params.trim()}`], declsOf(node), 'utilities');
      }
    }
  };

  const loaded = new Set();
  const load = (file, layer = null) => {
    if (loaded.has(file) || !existsSync(file)) return;
    loaded.add(file);
    walk(postcss.parse(readFileSync(file, 'utf8')).nodes, { file, layer, parents: null });
  };
  load(join(ROOT, entry));

  // Index each rule under its subject's most selective token.
  const index = new Map();
  const put = (key, rule) => index.set(key, [...(index.get(key) ?? []), rule]);
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      const key = subject.classes[0]
        ? `.${subject.classes[0]}`
        : subject.attrs.find((a) => a.name === 'class' && a.op === '~=')
          ? `.${subject.attrs.find((a) => a.name === 'class').value}`
          : subject.tag && subject.tag !== '*'
            ? subject.tag
            : subject.pseudo.some((p) => p.name === 'root')
              ? 'html'
              : '*';
      if (!(index.get(key) ?? []).includes(rule)) put(key, rule);
    }
  }
  return { rules, theme, index };
}

/** The rules whose selectors hold for an element, with the specificity each matched at. */
function matchingRules(styles, element) {
  const keys = new Set(['*', ...[...element.tags], ...[...element.classes].map((c) => `.${c}`)]);
  const out = [];
  for (const key of keys) {
    for (const rule of styles.index.get(key) ?? []) {
      let best = -1;
      for (const selector of rule.selectors) {
        const subject = selector.compounds.at(-1);
        const placeholder = subject.element === 'placeholder';
        if (subject.element && !placeholder) continue;
        if (!compoundMatches(subject, element.tags, element.classes)) continue;
        const ancestorsOk = selector.compounds
          .slice(0, -1)
          .every((compound) => compoundMatches(compound, element.ancestorTags, element.ancestorClasses));
        if (ancestorsOk) best = Math.max(best, selector.specificity + (placeholder ? 0.5 : 0));
      }
      if (best >= 0 && !out.some((m) => m.rule === rule)) out.push({ rule, specificity: Math.floor(best), placeholder: best % 1 !== 0 });
    }
  }
  return out;
}

// ── Tailwind utilities ──────────────────────────────────────────────────────

const RESPONSIVE = new Set(['sm', 'md', 'lg', 'xl', '2xl']);
const STRUCTURAL = new Set(['first', 'last', 'odd', 'even', 'only', 'group', 'peer']);

/** `md:hover:bg-white/80!` → { variants: ['md', 'hover'], important: true, base: 'bg-white/80', token }. */
export function parseUtility(token) {
  let body = token;
  let important = false;
  if (body.endsWith('!')) {
    important = true;
    body = body.slice(0, -1);
  }
  const parts = splitTop(body, [':']);
  let base = parts.pop() ?? '';
  if (base.startsWith('!')) {
    important = true;
    base = base.slice(1);
  }
  return { token, variants: parts, important, base };
}

/** The CSS a colour, size or display utility sets, as declarations. */
function utilityDecls({ base }, theme) {
  if (base === 'sr-only') return [{ prop: 'x-sr-only', value: '1' }];
  if (base === 'hidden') return [{ prop: 'display', value: 'none' }];
  if (/^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|contents|table-cell|table-row)$/.test(base)) return [{ prop: 'display', value: base }];
  if (base === 'invisible') return [{ prop: 'visibility', value: 'hidden' }];
  const opacity = /^opacity-(\d+)$/.exec(base);
  if (opacity) return [{ prop: 'opacity', value: String(Number(opacity[1]) / 100) }];
  // Tailwind's pulse fades the element to half opacity twice a second: read at its faintest.
  if (base === 'animate-pulse') return [{ prop: 'opacity', value: '0.5' }];
  if (/^bg-(linear|gradient|radial|conic)(-|$)/.test(base)) return [{ prop: 'x-gradient', value: '1' }];
  const width = /^border(-[xytrbl])?(-(\d+)|-\[(\d*\.?\d+)px\])?$/.exec(base);
  if (width) return [{ prop: 'border-width', value: width[3] ?? width[4] ?? '1' }];

  const match = /^(text|bg|border|border-[xytrbl]|from|via|to|outline|ring|fill|stroke|caret|accent|decoration|divide)-(.+)$/.exec(base);
  if (!match) return [];
  const [, kind, rest] = match;
  const [raw, modifier] = splitTop(rest, ['/']);
  let colour = null;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).replace(/^color:/, '').replaceAll('_', ' ');
    if (/^(#|rgb|rgba|oklch|hsl|color-mix|var\(|transparent|white|black)/i.test(inner)) colour = inner;
    else if (kind === 'text' && /^\d*\.?\d+(px|rem)$/.test(inner)) return [{ prop: 'font-size', value: inner }];
    else return [];
  } else if (raw.startsWith('(') && raw.endsWith(')')) colour = `var(${raw.slice(1, -1)})`;
  else if (raw === 'current') colour = 'currentColor';
  else if (raw === 'inherit') colour = 'inherit';
  else if (theme.has(`--color-${raw}`)) colour = `var(--color-${raw})`;
  else if (kind === 'text' && theme.has(`--text-${raw}`)) return [{ prop: 'font-size', value: theme.get(`--text-${raw}`) }];
  else return [];

  if (modifier !== undefined) {
    const share = modifier.startsWith('[') ? parseFloat(modifier.slice(1, -1)) * 100 : parseFloat(modifier);
    if (Number.isFinite(share)) colour = `color-mix(in srgb, ${colour} ${share}%, transparent)`;
  }
  const prop = {
    text: 'color',
    bg: 'background-color',
    from: 'x-stop',
    via: 'x-stop',
    to: 'x-stop',
  }[kind] ?? (kind.startsWith('border') ? 'border-color' : `x-${kind}`);
  return [{ prop, value: colour }];
}

// ── The page's files ────────────────────────────────────────────────────────

const isElement = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const openingOf = (element) => (ts.isJsxElement(element) ? element.openingElement : element);
const tagNameOf = (element) => openingOf(element).tagName.getText();
const isComponentTag = (name) => /^[A-Z]/.test(name) || name.includes('.');

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function attributeOf(element, name) {
  const found = openingOf(element).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
  return found ? { initializer: found.initializer } : null;
}

function resolveModule(fromFile, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts'), base]) {
    if (/\.(tsx|ts)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** The page's files: the entries and every TSX file they import, transitively. */
function loadFiles(entries) {
  const files = new Map();
  const queue = entries.map((entry) => join(ROOT, entry));
  while (queue.length > 0) {
    const path = queue.shift();
    if (files.has(path)) continue;
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(relative(ROOT, path).split(sep).join('/'), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const file = { path, source, imports: new Map(), lucide: new Set(), exports: new Map(), components: new Map() };
    files.set(path, file);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (specifier === 'lucide-react') {
          for (const element of clause?.namedBindings?.elements ?? []) file.lucide.add(element.name.text);
          continue;
        }
        const target = resolveModule(path, specifier);
        if (!target) continue;
        if (target.endsWith('.tsx')) queue.push(target);
        if (clause?.name) file.imports.set(clause.name.text, { path: target, name: 'default' });
        for (const element of clause?.namedBindings?.elements ?? []) {
          file.imports.set(element.name.text, { path: target, name: (element.propertyName ?? element.name).text });
        }
      }
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        file.components.set(statement.name.text, statement);
        if (exported) file.exports.set(isDefault ? 'default' : statement.name.text, statement);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declared of statement.declarationList.declarations) {
          const init = declared.initializer;
          if (ts.isIdentifier(declared.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            file.components.set(declared.name.text, init);
            if (exported) file.exports.set(declared.name.text, init);
          }
        }
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        const target = file.components.get(statement.expression.text);
        if (target) file.exports.set('default', target);
      }
    }
  }
  return files;
}

// ── Class names an element can have ─────────────────────────────────────────

const UNRESOLVED = '\u0000unresolved';
const unwrap = (expr) =>
  expr && (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr))
    ? unwrap(expr.expression)
    : expr;
const words = (text) => text.split(/\s+/).filter(Boolean);
const CLASS_HELPERS = new Set(['cn', 'clsx', 'cx', 'twMerge', 'classNames', 'twJoin']);

/**
 * A way an element's classes can resolve: the tokens, and the conditions that
 * chose them (`when`: condition → true/false). Two choices made by the same
 * condition must agree, so an "active" chip is never put inside an "inactive"
 * button when one test decides both.
 */
const NO_CONDITIONS = new Map();
const choice = (tokens, when = NO_CONDITIONS) => ({ tokens, when });

export function agree(a, b) {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const out = new Map(a);
  for (const [key, value] of b) {
    if (out.has(key) && out.get(key) !== value) return null;
    out.set(key, value);
  }
  return out;
}

const combine = (a, b) => {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const when = agree(x.when, y.when);
      if (when) out.push(choice([...x.tokens, ...y.tokens], when));
      if (out.length >= 128) return out;
    }
  }
  return out;
};

const assuming = (choices, key, value) =>
  choices.flatMap((c) => {
    const when = agree(c.when, new Map([[key, value]]));
    return when ? [choice(c.tokens, when)] : [];
  });

/** A condition, named by its text within its component, and whether it is negated. */
function conditionOf(input) {
  let expr = unwrap(input);
  let holds = true;
  while (expr && ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    holds = !holds;
    expr = unwrap(expr.operand);
  }
  let text = expr.getText();
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(expr.operatorToken.kind)) {
    holds = !holds;
    text = `${expr.left.getText()} === ${expr.right.getText()}`;
  }
  let scope = expr.getSourceFile().fileName;
  for (let n = expr.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))) {
      scope = `${scope}#${n.name?.getText() ?? n.pos}`;
      break;
    }
  }
  return { key: `${scope}|${text.replace(/\s+/g, ' ')}`, holds };
}

function declarationOf(identifier) {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declared of statement.declarationList.declarations) {
        if (ts.isIdentifier(declared.name) && declared.name.text === identifier.text) return declared.initializer ?? null;
      }
    }
  }
  return null;
}

function functionNamed(identifier) {
  let found = null;
  walk(identifier.getSourceFile(), (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === identifier.text) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init))) found = init;
    }
  });
  return found;
}

const valueOf = (object, key) =>
  object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === key)?.initializer;
const valuesOf = (object) => object.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? [p.initializer] : []));

function objectsOf(input, depth = 0) {
  const expr = unwrap(input);
  if (!expr || depth > 12) return [];
  if (ts.isObjectLiteralExpression(expr)) return [expr];
  if (ts.isIdentifier(expr)) return objectsOf(declarationOf(expr), depth + 1);
  if (ts.isElementAccessExpression(expr)) {
    return objectsOf(expr.expression, depth + 1).flatMap((object) => valuesOf(object).flatMap((value) => objectsOf(value, depth + 1)));
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return objectsOf(expr.expression, depth + 1).flatMap((object) => objectsOf(valueOf(object, expr.name.text), depth + 1));
  }
  return [];
}

/** Each way an expression's class tokens can resolve. What it cannot follow becomes one UNRESOLVED token. */
function classesOf(input, depth = 0) {
  const expr = unwrap(input);
  const none = [choice([])];
  const unknown = [choice([UNRESOLVED])];
  if (!expr) return none;
  if (depth > 14) return unknown;
  const next = (e) => classesOf(e, depth + 1);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [choice(words(expr.text))];
  if (ts.isJsxExpression(expr)) return next(expr.expression);
  if (ts.isTemplateExpression(expr)) {
    let choices = [choice(words(expr.head.text))];
    for (const span of expr.templateSpans) choices = combine(combine(choices, next(span.expression)), [choice(words(span.literal.text))]);
    return choices;
  }
  if (ts.isConditionalExpression(expr)) {
    const { key, holds } = conditionOf(expr.condition);
    return [...assuming(next(expr.whenTrue), key, holds), ...assuming(next(expr.whenFalse), key, !holds)];
  }
  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      const { key, holds } = conditionOf(expr.left);
      return [...assuming(next(expr.right), key, holds), ...assuming(none, key, !holds)];
    }
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return [...next(expr.left), ...next(expr.right)];
    if (operator === ts.SyntaxKind.PlusToken) return combine(next(expr.left), next(expr.right));
    return unknown;
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.UndefinedKeyword) return none;
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'undefined') return none;
    const init = declarationOf(expr);
    return init ? next(init) : unknown;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const objects = objectsOf(expr.expression);
    return objects.length ? objects.flatMap((object) => next(valueOf(object, expr.name.text))) : unknown;
  }
  if (ts.isElementAccessExpression(expr)) {
    const objects = objectsOf(expr.expression);
    return objects.length ? objects.flatMap((object) => valuesOf(object).flatMap(next)) : unknown;
  }
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.reduce((acc, element) => combine(acc, next(element)), none);
  if (ts.isObjectLiteralExpression(expr)) {
    // clsx object syntax: each key's classes, applied when its value holds.
    return expr.properties.reduce((acc, p) => {
      if (!ts.isPropertyAssignment(p)) return acc;
      const { key, holds } = conditionOf(p.initializer);
      const applied = [choice(words(p.name.getText().replace(/['"`]/g, '')))];
      return combine(acc, [...assuming(applied, key, holds), ...assuming(none, key, !holds)]);
    }, none);
  }
  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);
    if (ts.isIdentifier(callee) && CLASS_HELPERS.has(callee.text)) return expr.arguments.reduce((acc, arg) => combine(acc, next(arg)), none);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join' && ts.isArrayLiteralExpression(unwrap(callee.expression))) {
      return next(callee.expression);
    }
    if (ts.isIdentifier(callee)) {
      const target = functionNamed(callee);
      if (target && ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'cva') {
        // cva(base, { variants: { key: { option: classes } } }): the base with any one option of each variant.
        const [base, config] = target.arguments;
        let choices = next(base);
        const variants = config && ts.isObjectLiteralExpression(config) ? valueOf(config, 'variants') : null;
        for (const variant of variants && ts.isObjectLiteralExpression(variants) ? valuesOf(variants) : []) {
          if (ts.isObjectLiteralExpression(variant)) choices = combine(choices, valuesOf(variant).flatMap(next));
        }
        return choices;
      }
      if (target && (ts.isFunctionDeclaration(target) || ts.isArrowFunction(target) || ts.isFunctionExpression(target))) {
        const returned = [];
        if (target.body && !ts.isBlock(target.body)) returned.push(target.body);
        else walk(target.body, (inner) => {
          if (ts.isReturnStatement(inner) && inner.expression) returned.push(inner.expression);
        });
        return returned.length ? returned.flatMap(next) : unknown;
      }
    }
    return unknown;
  }
  return unknown;
}

/** Colour declarations from a `style={{ … }}` object, where they can be read. */
function inlineStyleDecls(element) {
  const style = attributeOf(element, 'style');
  const expr = style && unwrap(style.initializer?.expression);
  if (!expr || !ts.isObjectLiteralExpression(expr)) return { decls: [], unknown: false };
  const decls = [];
  let unknown = false;
  const propMap = { color: 'color', background: 'background', backgroundColor: 'background-color', borderColor: 'border-color', fontSize: 'font-size', opacity: 'opacity' };
  for (const property of expr.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const prop = propMap[property.name.getText().replace(/['"]/g, '')];
    if (!prop) continue;
    let value = unwrap(property.initializer);
    for (let hops = 0; value && ts.isIdentifier(value) && hops < 6; hops += 1) value = unwrap(declarationOf(value));
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) decls.push({ prop, value: value.text, important: false });
    else if (value && ts.isNumericLiteral(value)) decls.push({ prop, value: prop === 'font-size' ? `${value.text}px` : value.text, important: false });
    else unknown = true;
  }
  return { decls, unknown };
}

// ── The audit ───────────────────────────────────────────────────────────────

const LAYER_RANK = { theme: 0, base: 1, components: 2, utilities: 3 };
/** Conditions that name a state in which a control or section cannot be used. Dimming chosen by one is the disabled look. */
const INACTIVE = /[dD]isabled|(^|[^a-zA-Z])lock|Lock|[bB]usy|[lL]oading|[pP]ending|[iI]nactive|[uU]navailable|[sS]aving|[sS]ubmitting/;
const TEXT_LIKE_CALLS = /^(map|flatMap|filter|forEach)$/;

/** Whether an element puts its own text on the page (a text node or a text-like expression among its children). */
function hasOwnText(element) {
  if (!ts.isJsxElement(element)) return false;
  const textLike = (expr) => {
    const e = unwrap(expr);
    if (!e) return false;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return false;
    if (ts.isConditionalExpression(e)) return textLike(e.whenTrue) || textLike(e.whenFalse);
    if (ts.isBinaryExpression(e)) return textLike(e.right) || (e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && textLike(e.left));
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(callee) && TEXT_LIKE_CALLS.test(callee.name.text)) return false;
      // A call handed a function that returns elements (Array.from(…, () => <span/>)) renders elements.
      let rendersElements = false;
      for (const arg of e.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          walk(arg, (inner) => {
            if (isElement(inner) || ts.isJsxFragment(inner)) rendersElements = true;
          });
        }
      }
      return !rendersElements;
    }
    if (ts.isIdentifier(e)) return e.text !== 'children';
    if (ts.isPropertyAccessExpression(e)) return e.name.text !== 'children';
    return true;
  };
  const children = (nodes) =>
    nodes.some((child) => {
      if (ts.isJsxText(child)) return /\S/.test(child.text);
      if (ts.isJsxExpression(child)) return textLike(child.expression);
      if (ts.isJsxFragment(child)) return children(child.children);
      return false;
    });
  return children(element.children);
}

export function auditPages({ entries, css = 'app/globals.css', layouts = [] }) {
  const styles = loadStyles(css);
  const files = loadFiles([...entries, ...layouts]);
  const fileOf = (node) => files.get(join(ROOT, node.getSourceFile().fileName));

  const elements = [];
  for (const file of files.values()) walk(file.source, (node) => isElement(node) && elements.push(node));

  // Component definitions and where each is rendered.
  const definitionOf = (element) => {
    const name = tagNameOf(element);
    if (!isComponentTag(name) || name.includes('.')) return null;
    const file = fileOf(element);
    if (file.components.has(name)) return file.components.get(name);
    const imported = file.imports.get(name);
    const target = imported && files.get(imported.path);
    return target?.exports.get(imported.name) ?? null;
  };
  const usages = new Map();
  for (const element of elements) {
    const definition = definitionOf(element);
    if (definition) usages.set(definition, [...(usages.get(definition) ?? []), element]);
  }
  const enclosingDefinition = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const file = fileOf(node);
        if ([...file.components.values()].includes(n)) return n;
      }
    }
    return null;
  };
  const slotsOf = (definition) => {
    const slots = [];
    walk(definition, (node) => {
      if (ts.isJsxExpression(node) && node.expression) {
        const e = unwrap(node.expression);
        if ((ts.isIdentifier(e) && e.text === 'children') || (ts.isPropertyAccessExpression(e) && e.name.text === 'children')) slots.push(node);
      }
    });
    return slots;
  };
  // A Next.js page renders inside its layouts' {children}.
  const layoutSlots = layouts.flatMap((layout) => {
    const file = files.get(join(ROOT, layout));
    const definition = file?.exports.get('default');
    return definition ? slotsOf(definition) : [];
  });
  const isPage = (definition) => {
    const file = [...files.values()].find((f) => [...f.components.values()].includes(definition));
    return /(^|\/)page\.tsx$/.test(file?.source.fileName ?? '') && file.exports.get('default') === definition;
  };

  const jsxParent = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isJsxElement(n)) return n;
      if (ts.isFunctionDeclaration(n) || ts.isSourceFile(n)) return null;
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && [...fileOf(node).components.values()].includes(n)) return null;
    }
    return null;
  };
  const kindOf = (element) => {
    const name = tagNameOf(element);
    if (!isComponentTag(name)) return 'dom';
    if (fileOf(element).lucide.has(name)) return 'icon';
    return definitionOf(element) ? 'component' : 'external';
  };

  /** The painted elements (or ROOT) a node sits in, through components, slots and layouts. */
  const ROOT_NODE = { root: true };
  const parentMemo = new Map();
  const parentsOf = (node, via = [], depth = 0) => {
    if (depth > 40) return [ROOT_NODE];
    const memoable = via.length === 0;
    if (memoable && parentMemo.has(node)) return parentMemo.get(node);
    let result;
    const parent = jsxParent(node);
    if (parent) {
      const kind = kindOf(parent);
      if (kind === 'dom' || ((kind === 'external' || kind === 'icon') && attributeOf(parent, 'className'))) result = [parent];
      else if (kind === 'component') {
        const slots = slotsOf(definitionOf(parent));
        result = slots.length ? slots.flatMap((slot) => parentsOf(slot, [...via, parent], depth + 1)) : parentsOf(parent, via, depth + 1);
      } else result = parentsOf(parent, via, depth + 1);
    } else {
      const definition = enclosingDefinition(node);
      if (!definition) result = [ROOT_NODE];
      else if (via.length && definitionOf(via.at(-1)) === definition) result = parentsOf(via.at(-1), via.slice(0, -1), depth + 1);
      else if (usages.get(definition)?.length) result = usages.get(definition).flatMap((use) => parentsOf(use, [], depth + 1));
      else if (isPage(definition) && layoutSlots.length) result = layoutSlots.flatMap((slot) => parentsOf(slot, [], depth + 1));
      else result = [ROOT_NODE];
    }
    result = [...new Set(result)];
    if (memoable) parentMemo.set(node, result);
    return result;
  };

  // Each painted element's own classes, tags and the tokens above it.
  const own = new Map();
  const ownOf = (node) => {
    if (own.has(node)) return own.get(node);
    let info;
    if (node.root) info = { tags: new Set(['html', 'body']), classes: new Set(), choices: [choice([])], style: { decls: [], unknown: false } };
    else {
      const className = attributeOf(node, 'className');
      const choices = className ? classesOf(className.initializer) : [choice([])];
      const tag = { dom: tagNameOf(node).toLowerCase(), icon: 'svg', external: tagNameOf(node) === 'Link' ? 'a' : tagNameOf(node) === 'Image' ? 'img' : 'div' }[kindOf(node)] ?? 'div';
      info = {
        tags: new Set([tag]),
        classes: new Set(choices.flatMap((c) => c.tokens).filter((c) => c !== UNRESOLVED)),
        choices,
        style: inlineStyleDecls(node),
      };
    }
    own.set(node, info);
    return info;
  };
  const aboveMemo = new Map();
  const above = (node) => {
    if (node.root) return { tags: new Set(), classes: new Set() };
    if (aboveMemo.has(node)) return aboveMemo.get(node);
    aboveMemo.set(node, { tags: new Set(['html', 'body']), classes: new Set() });
    const tags = new Set(['html', 'body']);
    const classes = new Set();
    for (const parent of parentsOf(node)) {
      const info = ownOf(parent);
      const higher = above(parent);
      for (const t of [...info.tags, ...higher.tags]) tags.add(t);
      for (const c of [...info.classes, ...higher.classes]) classes.add(c);
    }
    const result = { tags, classes };
    aboveMemo.set(node, result);
    return result;
  };

  /**
   * The declarations that win for one way an element's classes can resolve,
   * in the viewport state given (`base`, or `wide` with sm:…2xl: applied).
   */
  const winners = (node, tokens, state) => {
    const info = ownOf(node);
    const higher = above(node);
    const classes = new Set(tokens.filter((t) => t !== UNRESOLVED));
    const candidates = [];
    const rules = matchingRules(styles, { tags: info.tags, classes, ancestorTags: higher.tags, ancestorClasses: higher.classes });
    for (const { rule, specificity, placeholder } of rules) {
      if (rule.viewport && rule.viewport !== state) continue;
      for (const decl of rule.decls) {
        const prop = placeholder && decl.prop === 'color' ? 'placeholder-color' : decl.prop;
        const layerRank = rule.layer ? LAYER_RANK[rule.layer] ?? 3 : 4;
        candidates.push({ ...decl, prop, rank: decl.important ? 10 - layerRank : layerRank, specificity, order: rule.order, source: `css "${rule.text.slice(0, 60)}"` });
      }
    }
    let order = 1e6;
    for (const token of classes) {
      const utility = parseUtility(token);
      const variants = utility.variants;
      const placeholder = variants.includes('placeholder');
      const active = variants.every((v) => (v === 'placeholder') || (state === 'wide' && RESPONSIVE.has(v)) || STRUCTURAL.has(v) || (state === 'base' && v.startsWith('max-')));
      if (!active) continue;
      order += 1;
      for (const decl of utilityDecls(utility, styles.theme)) {
        const prop = placeholder && decl.prop === 'color' ? 'placeholder-color' : decl.prop;
        const responsive = variants.some((v) => RESPONSIVE.has(v));
        candidates.push({ ...decl, prop, important: utility.important, rank: utility.important ? 7 : 3, specificity: 100, order: order + (responsive ? 1e5 : 0), source: token });
      }
    }
    for (const decl of info.style.decls) candidates.push({ ...decl, rank: 5, specificity: 1e4, order: 0, source: `style ${decl.prop}` });
    const best = new Map();
    for (const c of [...candidates]) {
      if (c.prop === 'border') {
        const width = /(^|\s)(\d*\.?\d+)px/.exec(c.value);
        candidates.push({ ...c, prop: 'border-width', value: /none|hidden/.test(c.value) ? '0' : width ? width[2] : '1' });
        const colour = splitTop(c.value, [' ']).filter((part) => !/^(\d*\.?\d+(px|rem|em)?|solid|dashed|dotted|double|none|hidden)$/.test(part)).join(' ');
        if (colour) candidates.push({ ...c, prop: 'border-color', value: colour });
      }
      if (c.prop === 'border-width') candidates.push({ ...c, prop: 'border-width', value: String(parseFloat(c.value) || 0) });
    }
    for (const c of candidates) {
      if (c.prop === 'border') continue;
      const prop = c.prop === 'background' ? 'background-color' : c.prop;
      const current = best.get(prop);
      if (!current || c.rank > current.rank || (c.rank === current.rank && (c.specificity > current.specificity || (c.specificity === current.specificity && c.order > current.order)))) {
        best.set(prop, { ...c, prop });
      }
    }
    // Gradient stops are painted together, not one over another.
    best.set('x-stop', candidates.filter((c) => c.prop === 'x-stop'));
    return best;
  };

  /** Custom properties in scope for an element: the stylesheet's globals, then its ancestors', then its own. */
  const varsMemo = new Map();
  const globalVars = new Map(styles.theme);
  for (const rule of styles.rules) {
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      const global = selector.compounds.length === 1 && !subject.classes.length && !subject.attrs.length && (subject.pseudo.some((p) => p.name === 'root') || subject.tag === 'html');
      if (global) for (const decl of rule.decls) if (decl.prop.startsWith('--')) globalVars.set(decl.prop, decl.value);
    }
  }
  const varsOf = (node) => {
    if (varsMemo.has(node)) return varsMemo.get(node);
    varsMemo.set(node, globalVars);
    const vars = new Map(globalVars);
    if (!node.root) for (const parent of parentsOf(node)) for (const [k, v] of varsOf(parent)) vars.set(k, v);
    const info = ownOf(node);
    const higher = above(node);
    for (const { rule } of matchingRules(styles, { tags: info.tags, classes: info.classes, ancestorTags: higher.tags, ancestorClasses: higher.classes })) {
      for (const decl of rule.decls) if (decl.prop.startsWith('--')) vars.set(decl.prop, decl.value);
    }
    varsMemo.set(node, vars);
    return vars;
  };

  /**
   * For each way an element can be painted: the colours under its content,
   * its text colours (own or inherited), its font size, and what it reads
   * from, per viewport state. Memoised per element.
   */
  // Disabled controls are exempt (WCAG 1.4.3), and so is what dims with them:
  // a look that holds only while a control's `disabled` condition holds.
  const disabledWhen = new Set();
  const alwaysDisabled = (element) => {
    for (const name of ['disabled', 'aria-disabled']) {
      const attr = attributeOf(element, name);
      if (!attr) continue;
      const expr = attr.initializer && unwrap(attr.initializer.expression ?? attr.initializer);
      if (!attr.initializer || expr?.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(expr) && expr.text === 'true')) return true;
    }
    return false;
  };
  for (const element of elements) {
    for (const name of ['disabled', 'aria-disabled']) {
      const expr = attributeOf(element, name)?.initializer?.expression;
      if (expr && !ts.isJsxExpression(expr) && expr.kind !== ts.SyntaxKind.TrueKeyword && expr.kind !== ts.SyntaxKind.FalseKeyword) {
        const { key, holds } = conditionOf(expr);
        disabledWhen.add(`${key}=${holds}`);
      }
    }
  }

  const lookMemo = new Map();
  let unresolvedColours = 0;
  const looksOf = (node) => {
    if (lookMemo.has(node)) return lookMemo.get(node);
    lookMemo.set(node, []);
    const parentLooks = node.root ? [] : parentsOf(node).flatMap(looksOf);
    const vars = varsOf(node);
    const info = ownOf(node);
    const looks = [];
    const always = !node.root && alwaysDisabled(node);
    for (const { tokens, when } of info.choices) {
      for (const state of ['base', 'wide']) {
        const win = winners(node, tokens, state);
        const unresolved = tokens.includes(UNRESOLVED) || info.style.unknown;
        const hidden = win.get('display')?.value === 'none' || win.get('visibility')?.value === 'hidden' || win.has('x-sr-only') || win.get('opacity')?.value === '0';
        const opacity = parseFloat(win.get('opacity')?.value ?? '1');
        const under = node.root ? [{ surface: [255, 255, 255], text: null, px: 16, hidden: false, opacity: 1, from: 'the page', when: NO_CONDITIONS, disabled: false }] : parentLooks.filter((l) => l.state === undefined || l.state === state);
        const bases = under.length ? under : [{ surface: [255, 255, 255], text: null, px: 16, hidden: false, opacity: 1, when: NO_CONDITIONS, disabled: false }];

        const colourDecl = win.get('color');
        let ownText = null;
        if (colourDecl && colourDecl.value !== 'inherit') {
          const painted = paintsOf(colourDecl.value, vars);
          if (painted.unknown || painted.paints.length === 0) unresolvedColours += 1;
          else ownText = painted.paints.map((paint) => ({ paint, source: colourDecl.source }));
        }
        // The background as layers, top first; each layer is its colour or its gradient's stops.
        const bgDecl = win.get('background-color');
        const stops = win.get('x-stop');
        let layers = null;
        let bgSource = null;
        if (win.has('x-gradient') && stops.length) {
          layers = [stops.flatMap((stop) => paintsOf(stop.value, vars).paints)];
          bgSource = stops.map((stop) => stop.source).join(' ');
        } else if (bgDecl) {
          layers = splitTop(String(bgDecl.value).replace(/!important/gi, ''), [',']).map((layer) => {
            // A radial or conic gradient is a glow placed somewhere on the element; where is not in
            // the source, so it is left out rather than laid under every word.
            if (/^(repeating-)?(radial|conic)-gradient\(/i.test(layer)) return [];
            const painted = paintsOf(layer, vars);
            return painted.current && ownText ? [...painted.paints, ...ownText.map((t) => t.paint)] : painted.paints;
          });
          bgSource = bgDecl.source;
        }
        const pxDecl = win.get('font-size');
        const px = pxDecl && /^(\d*\.?\d+)(px|rem)$/.test(pxDecl.value.trim()) ? parseFloat(pxDecl.value) * (pxDecl.value.trim().endsWith('rem') ? 16 : 1) : null;

        for (const base of bases) {
          const agreed = agree(base.when, when);
          if (!agreed) continue;
          // Layers stack bottom up: each stop of a layer over each colour beneath it.
          let beneath = [base.surface];
          for (const layer of [...(layers ?? [])].reverse()) {
            if (layer.length === 0) continue;
            beneath = [...new Map(layer.flatMap((paint) => beneath.map((colour) => over(paint, colour))).map((c) => [hex(c), c])).values()].slice(0, 24);
          }
          const surfaces = layers?.some((layer) => layer.length) ? beneath.map((colour) => ({ colour, source: bgSource })) : [{ colour: base.surface, source: base.from }];
          const texts = ownText ?? (unresolved && !colourDecl ? null : base.text);
          for (const surface of surfaces) {
            looks.push({
              state,
              surface: surface.colour,
              from: surface.source,
              text: texts,
              ownText: Boolean(ownText),
              unresolved: unresolved && !ownText,
              px: px ?? base.px,
              pxSource: pxDecl?.source ?? base.pxSource,
              hidden: base.hidden || hidden,
              opacity: base.opacity * (Number.isFinite(opacity) ? opacity : 1),
              when: agreed,
              disabled:
                base.disabled ||
                always ||
                [...agreed].some(([key, value]) => disabledWhen.has(`${key}=${value}`)) ||
                (opacity < 1 && [...when].some(([key, value]) => value && INACTIVE.test(key.split('|').pop()))),
              win,
              vars,
            });
          }
        }
      }
    }
    // Keep it bounded: one look per distinct surface, text and size.
    const distinct = new Map();
    for (const look of looks) {
      const key = `${look.state}|${hex(look.surface)}|${(look.text ?? []).map((t) => hex(t.paint) + t.paint[3].toFixed(2)).join(',')}|${look.px}|${look.hidden}|${look.opacity}|${look.disabled}|${[...look.when].map(([k, v]) => `${k}=${v}`).sort().join(';')}`;
      if (!distinct.has(key)) distinct.set(key, look);
    }
    const result = [...distinct.values()].slice(0, 400);
    lookMemo.set(node, result);
    return result;
  };

  // ── Checks ──
  const findings = new Map();
  const checked = { words: 0, icons: 0, fields: 0, sizes: 0 };
  const surfacesSeen = new Map();
  const lineOf = (node) => {
    const source = node.getSourceFile();
    return `${source.fileName}:${source.getLineAndCharacterOfPosition(openingOf(node).getStart(source)).line + 1}`;
  };
  const report = (node, category, what, colour, surface, need, extra = '') => {
    const ratio = contrast(colour, surface);
    if (ratio >= need) return;
    const line = `${lineOf(node)}  ${category} ${what} on ${hex(surface)}: ${ratio.toFixed(2)}:1, needs ${need}:1${extra}`;
    findings.set(line, { where: lineOf(node), category, what, on: hex(surface), ratio, need });
  };

  for (const node of elements) {
    const kind = kindOf(node);
    const tag = tagNameOf(node);
    const field = ['input', 'textarea', 'select'].includes(tag);
    const icon = kind === 'icon';
    const text = hasOwnText(node) || field;
    if (!icon && !text && kind !== 'dom') continue;
    if (kind === 'component' || (kind === 'external' && !attributeOf(node, 'className'))) continue;
    for (const look of looksOf(node)) {
      if (look.hidden || look.disabled) continue;
      surfacesSeen.set(hex(look.surface), look.surface);
      const need = icon ? NON_TEXT : WORDS;
      if ((text || icon) && look.text && !look.unresolved) {
        for (const { paint, source } of look.text) {
          const painted = over([paint[0], paint[1], paint[2], paint[3] * look.opacity], look.surface);
          checked[icon ? 'icons' : 'words'] += 1;
          report(node, icon ? 'icon' : 'words', source + (look.ownText ? '' : ' (inherited)'), painted, look.surface, need);
        }
      }
      if (text && !icon && look.px !== null) {
        checked.sizes += 1;
        if (look.px < SMALLEST_PX) {
          const line = `${lineOf(node)}  size ${look.pxSource ?? 'font-size'}: ${look.px}px, needs ${SMALLEST_PX}px`;
          findings.set(line, { where: lineOf(node), category: 'size', what: look.pxSource, px: look.px });
        }
      }
      if (field) {
        const placeholder = look.win.get('placeholder-color');
        if (placeholder && tag !== 'select') {
          for (const paint of paintsOf(placeholder.value, look.vars).paints) report(node, 'placeholder', placeholder.source, over(paint, look.surface), look.surface, WORDS);
        }
        const border = look.win.get('border-color');
        const width = parseFloat(look.win.get('border-width')?.value ?? '0');
        if (border && width > 0) {
          checked.fields += 1;
          const outside = parentsOf(node).flatMap(looksOf).filter((l) => l.state === look.state).map((l) => l.surface);
          for (const paint of paintsOf(border.value, look.vars).paints) {
            const edge = over(paint, look.surface);
            report(node, 'field edge', border.source, edge, look.surface, NON_TEXT);
            for (const surface of outside) report(node, 'field edge', border.source, edge, surface, NON_TEXT);
          }
        }
      }
    }
  }

  return {
    files: [...files.values()].map((f) => f.source.fileName).sort(),
    findings: [...findings.keys()].sort(),
    details: [...findings.values()],
    checked,
    surfacesSeen,
    unresolvedColours,
    styles,
  };
}
