import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import ts from 'typescript';

/**
 * Every word on /queue reads at 4.5:1 and 12px or more, and every icon and
 * text-field edge at 3:1.
 *
 * /queue is where payments are released, read quickly by the person who
 * answers for them. Its secondary text was #326273 at 55-80% (2.47-4.15:1 on
 * the cards), status words were --warn, --pending and --ok on their tints
 * (3.72-4.37:1), the approval code's placeholder was 25% teal (about 1.4:1),
 * and two text fields were outlined at 20-25% teal (1.35-1.46:1), which on a
 * near-white card is the only sign a field is there.
 *
 * WCAG 2.2 AA: 4.5:1 for text (1.4.3; everything here is 12-14px, so the
 * large-text allowance never applies), 3:1 for icons and for the edge that
 * identifies a field (1.4.11). Disabled controls are exempt.
 *
 * Size: nothing is set below 12px, the size of the board's column headers.
 * The approval code's label was 10px and the Example badge 11px.
 *
 * This reads the class names the files use, including those chosen by a
 * condition, a lookup table or a helper function. It works out what each
 * element sits on from the elements around it, and for a component from
 * where it is rendered. It blends translucent colours the way the browser
 * paints them, and measures WCAG relative luminance. Colour tokens come from
 * styles/tokens.css.
 */

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');

// ── Colour ──────────────────────────────────────────────────────────────────

const TOKENS = new Map(
  [...(await read('styles/tokens.css')).split(/:root\s*\{/)[1].split('}')[0].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(
    ([, name, value]) => [name, value],
  ),
);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (colour) => `#${colour.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** A paint (`[r, g, b, alpha]`) over an opaque colour, as the browser composites it. */
const over = ([r, g, b, alpha], under) => [r, g, b].map((c, i) => alpha * c + (1 - alpha) * under[i]);

function luminance(colour) {
  const [r, g, b] = colour.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const PAGE = rgb(TOKENS.get('bg'));
const WORDS = 4.5;
const NON_TEXT = 3;
const SMALLEST_PX = 12;

/** The size an arbitrary font-size class sets, in px (`text-[13px]`, `text-[0.75rem]`), or null. */
function fontSizePx(token) {
  const match = /^text-\[(\d*\.?\d+)(px|rem)\]$/.exec(token.split(':').at(-1));
  return match ? Number(match[1]) * (match[2] === 'rem' ? 16 : 1) : null;
}

const COLOUR_CLASS =
  /^(text|bg|border)-(?:\[(#[0-9a-fA-F]{6}|var\(--[\w-]+\))\]|(white|black))(?:\/(?:(\d{1,3})|\[(\d*\.?\d+)\]))?$/;

/** `hover:bg-white/80` → { variants: ['hover'], property: 'bg', paint: [255, 255, 255, 0.8] }. Null for anything but a colour. */
function colourClass(token) {
  const variants = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === '[') depth += 1;
    else if (token[i] === ']') depth -= 1;
    else if (token[i] === ':' && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  const match = COLOUR_CLASS.exec(token.slice(start));
  if (!match) return null;
  const [, property, arbitrary, named, percent, fraction] = match;
  let value = named === 'white' ? '#FFFFFF' : named === 'black' ? '#000000' : arbitrary;
  if (value.startsWith('var(')) {
    const name = value.slice('var(--'.length, -1);
    value = TOKENS.get(name);
    if (!value) throw new Error(`${token}: --${name} is not in styles/tokens.css`);
  }
  const alpha = percent !== undefined ? Number(percent) / 100 : fraction !== undefined ? Number(fraction) : 1;
  return { token, variants, property, paint: [...rgb(value), alpha] };
}

// ── The queue's files ───────────────────────────────────────────────────────

async function tsxIn(dir) {
  return (await readdir(new URL(dir, ROOT))).filter((name) => name.endsWith('.tsx')).map((name) => `${dir}${name}`);
}

const FILES = [...(await tsxIn('app/queue/')), ...(await tsxIn('components/queue/'))];
const SOURCES = await Promise.all(
  FILES.map(async (file) => ts.createSourceFile(file, await read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)),
);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isElement = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const openingOf = (element) => (ts.isJsxElement(element) ? element.openingElement : element);
const tagName = (element) => openingOf(element).tagName.getText();

function attribute(element, name) {
  const found = openingOf(element).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
  return found?.initializer;
}

function lineOf(element) {
  const source = element.getSourceFile();
  return `${source.fileName}:${source.getLineAndCharacterOfPosition(openingOf(element).getStart(source)).line + 1}`;
}

// ── Which classes an element can have ───────────────────────────────────────

const unwrap = (expr) =>
  expr && (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr))
    ? unwrap(expr.expression)
    : expr;

const split = (text) => text.split(/\s+/).filter(Boolean);

/** Every pairing of one choice from `a` with one from `b`. */
const combine = (a, b) => a.flatMap((x) => b.map((y) => [...x, ...y])).slice(0, 256);

/** The initializer of the nearest `const name = …` in scope. */
function declaration(identifier) {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declared of statement.declarationList.declarations) {
        if (ts.isIdentifier(declared.name) && declared.name.text === identifier.text) return declared.initializer;
      }
    }
  }
  return undefined;
}

/** What a call to a function declared in the same file can return. */
function returnsOf(identifier) {
  const found = [];
  walk(identifier.getSourceFile(), (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === identifier.text && node.body) {
      walk(node.body, (inner) => {
        if (ts.isReturnStatement(inner) && inner.expression) found.push(inner.expression);
      });
    }
  });
  return found;
}

const valueOf = (object, key) =>
  object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === key)?.initializer;
const valuesOf = (object) => object.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? [p.initializer] : []));

/** The object literals an expression can be: `laneMeta`, `laneMeta[lane]`, `tone` after `const tone = outcomeTone[kind]`. */
function objectsOf(input, depth = 0) {
  const expr = unwrap(input);
  if (!expr || depth > 12) return [];
  if (ts.isObjectLiteralExpression(expr)) return [expr];
  if (ts.isIdentifier(expr)) return objectsOf(declaration(expr), depth + 1);
  if (ts.isElementAccessExpression(expr)) {
    return objectsOf(expr.expression, depth + 1).flatMap((object) => valuesOf(object).flatMap((value) => objectsOf(value, depth + 1)));
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return objectsOf(expr.expression, depth + 1).flatMap((object) => objectsOf(valueOf(object, expr.name.text), depth + 1));
  }
  return [];
}

/** Each set of classes an expression can produce. Anything it cannot follow adds none. */
function classesOf(input, depth = 0) {
  const expr = unwrap(input);
  if (!expr || depth > 12) return [[]];
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [split(expr.text)];
  if (ts.isJsxExpression(expr)) return classesOf(expr.expression, depth + 1);
  if (ts.isTemplateExpression(expr)) {
    let choices = [split(expr.head.text)];
    for (const span of expr.templateSpans) {
      choices = combine(combine(choices, classesOf(span.expression, depth + 1)), [split(span.literal.text)]);
    }
    return choices;
  }
  if (ts.isConditionalExpression(expr)) return [...classesOf(expr.whenTrue, depth + 1), ...classesOf(expr.whenFalse, depth + 1)];
  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return [...classesOf(expr.right, depth + 1), []];
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return [...classesOf(expr.left, depth + 1), ...classesOf(expr.right, depth + 1)];
    }
    if (operator === ts.SyntaxKind.PlusToken) return combine(classesOf(expr.left, depth + 1), classesOf(expr.right, depth + 1));
    return [[]];
  }
  if (ts.isIdentifier(expr)) return classesOf(declaration(expr), depth + 1);
  if (ts.isPropertyAccessExpression(expr)) {
    return objectsOf(expr.expression).flatMap((object) => classesOf(valueOf(object, expr.name.text), depth + 1));
  }
  if (ts.isElementAccessExpression(expr)) {
    return objectsOf(expr.expression).flatMap((object) => valuesOf(object).flatMap((value) => classesOf(value, depth + 1)));
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const returned = returnsOf(expr.expression);
    return returned.length > 0 ? returned.flatMap((value) => classesOf(value, depth + 1)) : [[]];
  }
  return [[]];
}

/** Each way this element's colour classes can resolve. */
function colourChoices(element) {
  const className = attribute(element, 'className');
  if (!className) return [[]];
  return classesOf(className).map((tokens) => tokens.map(colourClass).filter(Boolean));
}

const exempt = (c) => c.variants.some((v) => v === 'disabled' || v.startsWith('aria-disabled'));
const plain = (c) => c.variants.every((v) => ['sm', 'md', 'lg', 'xl', '2xl'].includes(v));
const ownBackground = (classes) => classes.filter((c) => c.property === 'bg' && plain(c)).at(-1)?.paint ?? null;

// ── What each element sits on ───────────────────────────────────────────────

/** The element this one renders inside, or null at the top of a component. */
function parentElement(element) {
  for (let node = element.parent; node; node = node.parent) {
    if (ts.isJsxElement(node)) return node;
    if (ts.isFunctionDeclaration(node)) return null;
  }
  return null;
}

function componentOf(element) {
  for (let node = element.parent; node; node = node.parent) {
    if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  }
  return null;
}

/** Where each component is rendered, across the queue's files. */
const RENDERED_AT = new Map();
for (const source of SOURCES) {
  walk(source, (node) => {
    if (isElement(node)) RENDERED_AT.set(tagName(node), [...(RENDERED_AT.get(tagName(node)) ?? []), node]);
  });
}

const unique = (colours) => [...new Map(colours.map((c) => [hex(c), c])).values()];

/** The opaque colours that can be under this element: its parent's, or wherever its component is rendered, or the page. */
function backdrop(element, seen = new Set()) {
  const parent = parentElement(element);
  if (parent) return surfacesOf(parent, seen);
  const renderedAt = RENDERED_AT.get(componentOf(element)) ?? [];
  if (renderedAt.length === 0) return [PAGE];
  return unique(renderedAt.flatMap((use) => surfacesOf(use, seen)));
}

const SURFACES = new Map();

/** What this element shows through to its children: its own background, if any, over its backdrop. */
function surfacesOf(element, seen = new Set()) {
  if (SURFACES.has(element)) return SURFACES.get(element);
  if (seen.has(element)) return [PAGE];
  seen.add(element);
  const under = backdrop(element, seen);
  const result = unique(
    colourChoices(element).flatMap((classes) => {
      const background = ownBackground(classes);
      return background ? under.map((colour) => over(background, colour)) : under;
    }),
  );
  SURFACES.set(element, result);
  return result;
}

// ── The checks ──────────────────────────────────────────────────────────────

function audit() {
  const failures = new Set();
  const checked = { words: 0, icons: 0, fields: 0 };
  const surfacesSeen = new Map();

  const measure = (element, token, colour, surface, need, what) => {
    const ratio = contrast(colour, surface);
    if (ratio < need) failures.add(`${lineOf(element)}  ${what} ${token} on ${hex(surface)}: ${ratio.toFixed(2)}:1, needs ${need}:1`);
  };

  for (const source of SOURCES) {
    walk(source, (element) => {
      if (!isElement(element)) return;
      const choices = colourChoices(element);
      if (choices.every((classes) => classes.length === 0)) return;

      const hidden = attribute(element, 'aria-hidden');
      const icon =
        ts.isJsxSelfClosingElement(element) &&
        hidden !== undefined &&
        ((ts.isStringLiteral(hidden) && hidden.text === 'true') || hidden.expression?.kind === ts.SyntaxKind.TrueKeyword);
      const field = ['input', 'textarea', 'select'].includes(tagName(element));
      const under = backdrop(element);

      for (const classes of choices) {
        const background = ownBackground(classes);
        const here = background ? under.map((colour) => over(background, colour)) : under;
        const hover = classes.find((c) => c.property === 'bg' && c.variants.join(':') === 'hover');
        for (const surface of here) surfacesSeen.set(hex(surface), surface);

        for (const c of classes) {
          if (exempt(c)) continue;
          if (c.property === 'text') {
            const need = icon ? NON_TEXT : WORDS;
            const what = icon ? 'icon' : c.variants.includes('placeholder') ? 'placeholder' : 'words';
            checked[icon ? 'icons' : 'words'] += 1;
            for (const surface of here) {
              measure(element, c.token, over(c.paint, surface), surface, need, what);
              // Hovered, the same words sit on the hover background.
              if (hover && plain(c)) {
                const hovered = over(hover.paint, surface);
                measure(element, `${c.token} (hover:${hover.token.split(':').at(-1)})`, over(c.paint, hovered), hovered, need, what);
              }
            }
          }
          if (field && c.property === 'border' && plain(c)) {
            checked.fields += 1;
            for (const inside of here) {
              const edge = over(c.paint, inside);
              measure(element, c.token, edge, inside, NON_TEXT, 'field edge');
              for (const outside of under) measure(element, c.token, edge, outside, NON_TEXT, 'field edge');
            }
          }
        }
      }
    });
  }
  return { failures: [...failures], checked, surfacesSeen };
}

const RESULT = audit();
const report = (failures) => `\n  ${failures.join('\n  ')}\n`;

test('the measurements match WCAG on colours whose ratios are known', () => {
  const white = [255, 255, 255];
  const card = over([...white, 0.85], PAGE);
  const teal = rgb('#326273');
  const pairs = [
    ['#326273 at 60% on a lane (white/85 on the page)', over([...teal, 0.6], card), card, 2.72],
    ['#326273 at 90% on a lane', over([...teal, 0.9], card), card, 5.21],
    ['--warn on --warn-bg', rgb(TOKENS.get('warn')), rgb(TOKENS.get('warn-bg')), 3.72],
    ['--ok on --ok-bg', rgb(TOKENS.get('ok')), rgb(TOKENS.get('ok-bg')), 4.25],
    ['ink on --ok-bg', rgb('#1F4452'), rgb(TOKENS.get('ok-bg')), 9.02],
    ['white/75 on ink', over([...white, 0.75], rgb('#1F4452')), rgb('#1F4452'), 6.69],
    ['a 20% teal field edge on white', over([...teal, 0.2], white), white, 1.35],
  ];
  for (const [label, foreground, background, expected] of pairs) {
    assert.equal(contrast(foreground, background).toFixed(2), expected.toFixed(2), label);
  }
  assert.deepEqual(
    colourClass('placeholder:text-[#326273]/90'),
    { token: 'placeholder:text-[#326273]/90', variants: ['placeholder'], property: 'text', paint: [50, 98, 115, 0.9] },
  );
  assert.deepEqual(colourClass('bg-[#326273]/[0.03]').paint, [50, 98, 115, 0.03]);
  assert.deepEqual(colourClass('text-[var(--ok)]').paint, [...rgb(TOKENS.get('ok')), 1]);
  assert.equal(colourClass('text-[13px]'), null);
  assert.equal(colourClass('border-l-4'), null);
});

test('the check finds every surface the queue paints, through conditions, lookups and where components render', (t) => {
  const white = [255, 255, 255];
  const wash = over([50, 98, 115, 0.03], PAGE);
  const expected = {
    'the page': PAGE,
    'the lanes (white/85)': over([...white, 0.85], PAGE),
    'the board and code card (white/80)': over([...white, 0.8], PAGE),
    'decided just now (white/70)': over([...white, 0.7], PAGE),
    'the examples wash': wash,
    'an example card (white/60 on the wash)': over([...white, 0.6], wash),
    'a field (white)': white,
    'a MEDIUM risk chip or the finding note (--warn-bg)': rgb(TOKENS.get('warn-bg')),
    'a LOW risk chip or a sent chip (--ok-bg)': rgb(TOKENS.get('ok-bg')),
    'a HIGH risk chip or a refusal (--error-bg)': rgb(TOKENS.get('error-bg')),
    'a primary button (ink)': rgb('#1F4452'),
  };
  for (const [label, colour] of Object.entries(expected)) {
    assert.ok(RESULT.surfacesSeen.has(hex(colour)), `${label} ${hex(colour)} was not found`);
  }
  const { words, icons, fields } = RESULT.checked;
  t.diagnostic(`${FILES.length} files: ${words} word colours, ${icons} icon colours, ${fields} field edges, on ${RESULT.surfacesSeen.size} surfaces`);
  assert.ok(RESULT.checked.words >= 40, `only ${RESULT.checked.words} word colours were checked`);
  assert.ok(RESULT.checked.icons >= 8, `only ${RESULT.checked.icons} icon colours were checked`);
  assert.ok(RESULT.checked.fields >= 2, `only ${RESULT.checked.fields} field edges were checked`);
});

test('every word on /queue reads at 4.5:1 against what it sits on', () => {
  const words = RESULT.failures.filter((line) => / (words|placeholder) /.test(line));
  assert.equal(words.length, 0, report(words));
});

test('every icon on /queue is at least 3:1 against what it sits on', () => {
  const icons = RESULT.failures.filter((line) => / icon /.test(line));
  assert.equal(icons.length, 0, report(icons));
});

test('every text field on /queue shows its edge at 3:1, inside and out', () => {
  const edges = RESULT.failures.filter((line) => / field edge /.test(line));
  assert.equal(edges.length, 0, report(edges));
});

test('nothing on /queue is set smaller than 12px', () => {
  const small = [];
  let sized = 0;
  for (const source of SOURCES) {
    walk(source, (element) => {
      const className = isElement(element) ? attribute(element, 'className') : undefined;
      if (!className) return;
      for (const token of new Set(classesOf(className).flat())) {
        const px = fontSizePx(token);
        if (px === null) continue;
        sized += 1;
        if (px < SMALLEST_PX) small.push(`${lineOf(element)}  ${token}: ${px}px, needs ${SMALLEST_PX}px`);
      }
    });
  }
  assert.ok(sized >= 30, `only ${sized} sized elements were found`);
  assert.equal(small.length, 0, report(small));
});
