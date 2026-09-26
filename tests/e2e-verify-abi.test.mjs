/**
 * The key ceremony's verify step (scripts/e2e-testnet.mjs, runbook §3.8)
 * calls splash_core with the parameters in scripts/splash-core-abi.mjs. It
 * went stale once already: Phase 7 added a CapRegistry argument and the calls
 * became generic, and nothing failed until someone read the script. These
 * tests hold the table to the Move source, and the script to the table, to the
 * core package and to its simulate-first rules, so the next signature change
 * fails here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SPLASH_CORE_ABI } from '../scripts/splash-core-abi.mjs';

const root = new URL('../', import.meta.url);
/** A file's text with LF line endings, so the patterns below hold on a CRLF
 *  (Windows autocrlf) checkout too. */
async function source(rel) {
  return (await readFile(new URL(rel, root), 'utf8')).split(/\r?\n/).join('\n');
}

/** Split at commas outside angle brackets: `Coin<T>, &Clock`. */
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '<') depth += 1;
    if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function withoutComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const PRIMITIVES = new Set(['address', 'bool', 'u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'signer']);

/** What each bare type name in a module refers to, as `module::Name`: the
 *  implicit Sui Move 2024 imports, its `use` imports and its own structs. */
function typeScope(moduleName, code) {
  const names = new Map([
    ['TxContext', 'tx_context::TxContext'],
    ['UID', 'object::UID'],
    ['ID', 'object::ID'],
    ['Option', 'option::Option'],
  ]);
  for (const m of code.matchAll(/\bstruct\s+(\w+)/g)) names.set(m[1], `${moduleName}::${m[1]}`);
  for (const m of code.matchAll(/\buse\s+([\w:]+?)::(\{[^}]*\}|\w+(?:\s+as\s+\w+)?)\s*;/g)) {
    const [, path, members] = m;
    const owner = path.split('::').at(-1);
    const list = members.startsWith('{') ? splitTopLevel(members.slice(1, -1)) : [members];
    for (const member of list) {
      const [original, alias] = member.split(/\s+as\s+/).map((s) => s.trim());
      if (original !== 'Self') names.set(alias ?? original, `${owner}::${original}`);
    }
  }
  return names;
}

function qualify(type, scope, generics) {
  let rest = type.trim();
  let ref = '';
  const refMatch = /^&\s*(mut\s+)?/.exec(rest);
  if (refMatch) {
    ref = refMatch[1] ? '&mut ' : '&';
    rest = rest.slice(refMatch[0].length).trim();
  }
  const open = rest.indexOf('<');
  const head = (open < 0 ? rest : rest.slice(0, open)).trim();
  const args = open < 0 ? [] : splitTopLevel(rest.slice(open + 1, rest.lastIndexOf('>')));
  let name;
  if (generics.includes(head)) return `${ref}T${generics.indexOf(head)}`;
  if (PRIMITIVES.has(head) || head === 'vector') name = head;
  else if (head.includes('::')) name = head.split('::').slice(-2).join('::');
  else if (scope.has(head)) name = scope.get(head);
  else assert.fail(`cannot resolve the type ${head}`);
  return ref + (args.length ? `${name}<${args.map((a) => qualify(a, scope, generics)).join(', ')}>` : name);
}

/**
 * A `public fun` as the source declares it: its parameter types qualified as
 * the node reports them (`clock::Clock`, `T0`), the trailing TxContext left
 * off, and how many type parameters it takes.
 */
async function sourceFunction(moduleName, fnName) {
  const code = withoutComments(await source(`move/splash_core/sources/${moduleName}.move`));
  const match = new RegExp(`public\\s+fun\\s+${fnName}\\s*(<[^>]*>)?\\s*\\(`).exec(code);
  assert.ok(match, `${moduleName}::${fnName} is not a public fun in move/splash_core/sources/${moduleName}.move`);
  const generics = match[1] ? splitTopLevel(match[1].slice(1, -1)).map((g) => g.split(':')[0].trim()) : [];

  let depth = 1;
  let end = match.index + match[0].length;
  while (depth > 0) {
    if (code[end] === '(') depth += 1;
    if (code[end] === ')') depth -= 1;
    end += 1;
  }
  const scope = typeScope(moduleName, code);
  const types = splitTopLevel(code.slice(match.index + match[0].length, end - 1)).map((param) =>
    qualify(param.slice(param.indexOf(':') + 1), scope, generics),
  );
  if (/^&(mut )?tx_context::TxContext$/.test(types.at(-1) ?? '')) types.pop();
  return { signature: types.join(', '), typeParameters: generics.length };
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if ('([{'.includes(text[i])) depth += 1;
    if (')]}'.includes(text[i])) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return assert.fail(`unbalanced bracket at ${open}`);
}

/** Items of a list at its own depth: `a, f(b, c), [d]` is three. */
function topLevelItems(inner) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Every `.moveCall({...})` in the script: its target, how many arguments it
 *  passes, and whether it passes type arguments. */
function moveCalls(script) {
  return [...script.matchAll(/\.moveCall\(\{/g)].map((m) => {
    const open = m.index + m[0].length - 1;
    const body = script.slice(open, closeOf(script, open));
    const listAfter = (key) => {
      const at = body.search(new RegExp(`\\b${key}: \\[`));
      if (at < 0) return [];
      const open = body.indexOf('[', at);
      return topLevelItems(body.slice(open + 1, closeOf(body, open) - 1));
    };
    return {
      target: /target: `\$\{PACKAGE\}::(\w+::\w+)`/.exec(body)?.[1] ?? null,
      args: listAfter('arguments').length,
      typeArguments: listAfter('typeArguments').length,
    };
  });
}

/** The body of a top-level function in the script, up to the next one. */
function functionBody(script, name) {
  const start = script.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `scripts/e2e-testnet.mjs defines ${name}`);
  const next = script.slice(start + 1).search(/\n(async )?function \w+\(|\nclass |\nconst \w+ = /);
  return next < 0 ? script.slice(start) : script.slice(start, start + 1 + next);
}

test('every splash_core call in the verify table matches the Move source, module paths included', async () => {
  const entries = Object.entries(SPLASH_CORE_ABI);
  assert.ok(entries.length >= 7, 'the table lists the calls the verify script makes');
  for (const [fn, signature] of entries) {
    const [moduleName, name] = fn.split('::');
    assert.equal(
      signature,
      (await sourceFunction(moduleName, name)).signature,
      `${fn} in scripts/splash-core-abi.mjs no longer matches move/splash_core/sources/${moduleName}.move`,
    );
  }
});

test("every call the verify script builds is in the table, on the core package, with the table's arguments", async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  const calls = moveCalls(script);
  assert.equal(calls.length, script.match(/\.moveCall\(/g)?.length, 'every moveCall is written as .moveCall({ … })');
  assert.ok(calls.length >= 7, 'the script builds its calls with moveCall');
  for (const call of calls) {
    assert.ok(call.target, 'every moveCall names its target as `${PACKAGE}::module::function`');
    const signature = SPLASH_CORE_ABI[call.target];
    assert.ok(signature, `${call.target} is called but not in scripts/splash-core-abi.mjs`);
    // The Phase 7 break was exactly this: update_peg and anchor_audit_hash
    // kept passing one argument fewer after the CapRegistry was added.
    assert.equal(call.args, splitTopLevel(signature).length, `${call.target} passes ${call.args} arguments; the source takes ${splitTopLevel(signature).length}`);
    // And the other half: create_payment_intent and confirm_payment_intent
    // became generic over the coin type.
    const [moduleName, name] = call.target.split('::');
    const { typeParameters } = await sourceFunction(moduleName, name);
    assert.equal(call.typeArguments, typeParameters, `${call.target} passes ${call.typeArguments} type arguments; the source takes ${typeParameters}`);
  }
});

test('the verify script touches no custody module: splash_custody does not publish in Phase 0', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  // Calls are covered by the table test above; these are the custody entry
  // points and ids the old script used.
  for (const custody of [
    'smart_treasury::deposit',
    'settle_sui_batch',
    'settlement::new_payment',
    'SPLASH_CUSTODY_PACKAGE_ID',
    'SPLASH_SMART_TREASURY_SUI_ID',
    'SPLASH_TREASURY_ID',
  ]) {
    assert.ok(!script.includes(custody), `scripts/e2e-testnet.mjs mentions ${custody}`);
  }
});

test('the verify script reads the ids the app reads, with no AdminCap stand-in for the AnchorCap', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  for (const key of ['SPLASH_CORE_PACKAGE_ID', 'SPLASH_PACKAGE_ID', 'SPLASH_ANCHOR_CAP_ID', 'SPLASH_CAP_REGISTRY_ID']) {
    assert.ok(script.includes(`'${key}'`), `scripts/e2e-testnet.mjs reads ${key}`);
  }
  assert.match(script, /\nconst ANCHOR_CAP = objectIdFromEnv\('SPLASH_ANCHOR_CAP_ID', \{ required: true \}\);\n/);
  assert.equal(script.match(/\bconst ANCHOR_CAP\b/g)?.length, 1, 'ANCHOR_CAP is defined once');
  assert.doesNotMatch(script, /tx\.object\(ADMIN_CAP\)|ANCHOR_CAP\s*=[^\n]*ADMIN/);
});

test('without --execute nothing can sign, and --execute sends only on testnet after a clean simulation', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  assert.match(script, /const EXECUTE = args\.includes\('--execute'\);/);

  // No signer exists in a simulation, and the key is read only to make one:
  // the environment is read through env() alone, and env() reads the key once,
  // inside operatorSigner.
  assert.match(script, /\nconst signer = EXECUTE \? operatorSigner\(\) : null;\n/);
  assert.equal(script.match(/process\.env/g)?.length, 1, 'process.env is read only by env()');
  assert.match(script, /\nconst env = \(k\) => \(process\.env\[k\] \?\? ''\)\.trim\(\);\n/);
  assert.equal(script.match(/env\('OPERATOR_SUI_PRIVATE_KEY'\)/g)?.length, 1, 'the key is read in one place');
  assert.match(functionBody(script, 'operatorSigner'), /env\('OPERATOR_SUI_PRIVATE_KEY'\)/);

  // Signing happens in execute() alone, and every call of execute() is in the
  // executed-payment check.
  assert.equal(script.match(/signAndExecuteTransaction|executeTransaction/g)?.length, 1);
  assert.match(functionBody(script, 'execute'), /signAndExecuteTransaction/);
  const callSites = (text) => [...text.matchAll(/(?<![\w.])execute\(/g)].filter((m) => !text.slice(0, m.index).endsWith('function ')).length;
  assert.ok(callSites(script) >= 2);
  assert.equal(callSites(functionBody(script, 'checkPaymentExecuted')), callSites(script), 'execute() is called only from checkPaymentExecuted');

  // That check runs once, inside `if (EXECUTE)`, after the failure gate, and
  // after every simulation.
  assert.equal(script.match(/checkPaymentExecuted/g)?.length, 2, 'defined once, called once');
  const main = functionBody(script, 'main');
  assert.match(
    main,
    /if \(EXECUTE\) \{[\s\S]*?if \(results\.some\(\(r\) => r\.status === 'FAIL'\)\) \{[\s\S]*?\} else \{\s*await run\('Payment \(executed\)', checkPaymentExecuted\);/,
  );
  const order = [
    'await checkChain()',
    'await checkIds()',
    'await checkAbi()',
    "gated('Peg refresh (simulated)'",
    "gated('Payment intent (simulated)'",
    "gated('Confirm + anchors (simulated)'",
    "await run('Payment (executed)'",
  ].map((marker) => {
    assert.ok(main.includes(marker), `main runs ${marker}`);
    return main.indexOf(marker);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'main simulates everything before it may send');

  // The chain id, not SUI_NETWORK alone, decides.
  assert.match(script, /testnet: '4c78adac'/);
  assert.match(functionBody(script, 'checkChain'), /if \(EXECUTE && chainId !== CHAIN_IDS\.testnet\) \{\s*refuse\(/);
});

test('the verify script never calls process.exit once the chain has answered: on Windows it would report 127', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  const exits = script.match(/process\.exit\(/g)?.length ?? 0;
  assert.equal(exits, 1, 'one process.exit, in stop()');
  assert.match(functionBody(script, 'stop'), /process\.exit\(1\)/);
  assert.match(functionBody(script, 'main'), /process\.exitCode = failed\.length \? 1 : 0;/);
  // stop() is that process.exit, so it is called only while the configuration
  // is read, above the first function that talks to the chain.
  const firstChainCode = script.indexOf('\nasync function simulate(');
  assert.ok(firstChainCode > 0);
  const stops = [...script.matchAll(/(?<![\w.])stop\(/g)].filter((m) => !script.slice(0, m.index).endsWith('function '));
  assert.ok(stops.length > 0);
  for (const m of stops) {
    assert.ok(m.index < firstChainCode, `stop() at offset ${m.index} runs after the chain may have answered; use refuse()`);
  }
});
