/**
 * The key ceremony's verify step (scripts/e2e-testnet.mjs, runbook §3.8)
 * calls splash_core with the parameters in scripts/splash-core-abi.mjs. It
 * went stale once already: Phase 7 added a CapRegistry argument and the calls
 * became generic, and nothing failed until someone read the script. These
 * tests hold the table to the Move source, and the script to the table, to the
 * core package and to the v2 rules it checks (it cannot sign; the payment runs
 * as the business wallet; the operator alone is refused), so the next
 * signature change fails here.
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

/** The framework calls the script may make, with their argument and
 *  type-argument counts: redeeming the business wallet's address balance. */
const FRAMEWORK_CALLS = {
  '0x2::balance::redeem_funds': { args: 1, typeArguments: 1 },
};

/** Every `.moveCall({...})` in the script: its target (a core function as
 *  `module::function`, or a framework one as written), how many arguments it
 *  passes, and how many type arguments. */
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
    const core = /target: `\$\{PACKAGE\}::(\w+::\w+)`/.exec(body)?.[1] ?? null;
    const framework = /target: '(0x2::\w+::\w+)'/.exec(body)?.[1] ?? null;
    return {
      target: core,
      framework,
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

/** A `const NAME: type = value;` in a core module, as a number. */
async function moveConstant(moduleName, name) {
  const code = withoutComments(await source(`move/splash_core/sources/${moduleName}.move`));
  const m = new RegExp(`\\bconst\\s+${name}\\s*:\\s*u\\d+\\s*=\\s*(\\d+)\\s*;`).exec(code);
  assert.ok(m, `${moduleName}.move declares ${name}`);
  return Number(m[1]);
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
  const called = new Set();
  for (const call of calls) {
    if (call.framework) {
      const expected = FRAMEWORK_CALLS[call.framework];
      assert.ok(expected, `${call.framework} is a framework call the verify script is not expected to make`);
      assert.equal(call.args, expected.args, `${call.framework} passes ${call.args} arguments`);
      assert.equal(call.typeArguments, expected.typeArguments, `${call.framework} passes ${call.typeArguments} type arguments`);
      continue;
    }
    assert.ok(call.target, 'every core moveCall names its target as `${PACKAGE}::module::function`');
    called.add(call.target);
    const signature = SPLASH_CORE_ABI[call.target];
    assert.ok(signature, `${call.target} is called but not in scripts/splash-core-abi.mjs`);
    // The Phase 7 break was exactly this: update_peg and anchor_audit_hash
    // kept passing one argument fewer after the CapRegistry was added.
    assert.equal(call.args, splitTopLevel(signature).length, `${call.target} passes ${call.args} arguments; the source takes ${splitTopLevel(signature).length}`);
    // And the other half: the payment calls are generic over the coin type.
    const [moduleName, name] = call.target.split('::');
    const { typeParameters } = await sourceFunction(moduleName, name);
    assert.equal(call.typeArguments, typeParameters, `${call.target} passes ${call.typeArguments} type arguments; the source takes ${typeParameters}`);
  }
  // The table names nothing the script does not call, so the on-chain
  // signature check covers exactly what runs.
  assert.deepEqual([...called].sort(), Object.keys(SPLASH_CORE_ABI).sort());
});

test('the verify script touches no custody module and no removed v1 payment call', async () => {
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
    'SPLASH_PAYOUT_DELEGATION_ID',
  ]) {
    assert.ok(!script.includes(custody), `scripts/e2e-testnet.mjs mentions ${custody}`);
  }
  // v2 removed the unbound path, in which any signer opened and paid an intent.
  assert.doesNotMatch(script, /payment_intent::(create_payment_intent|create|confirm_payment_intent)`/);
});

test('the verify script reads the ids the app reads, with no AdminCap stand-in for the AnchorCap', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  for (const key of [
    'SPLASH_CORE_PACKAGE_ID',
    'SPLASH_PACKAGE_ID',
    'SPLASH_ANCHOR_CAP_ID',
    'SPLASH_CAP_REGISTRY_ID',
    'SPLASH_COMPLIANCE_CONFIG_ID',
    'SPLASH_VERIFY_BUSINESS_ACCOUNT_ID',
  ]) {
    assert.ok(script.includes(`'${key}'`), `scripts/e2e-testnet.mjs reads ${key}`);
  }
  assert.match(script, /\nconst ANCHOR_CAP = objectIdFromEnv\('SPLASH_ANCHOR_CAP_ID', \{ required: true \}\);\n/);
  assert.equal(script.match(/\bconst ANCHOR_CAP\b/g)?.length, 1, 'ANCHOR_CAP is defined once');
  assert.doesNotMatch(script, /tx\.object\(ADMIN_CAP\)|ANCHOR_CAP\s*=[^\n]*ADMIN/);
});

test('the verify script cannot sign: it holds no key and only simulates', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  // No key is read and nothing can sign or send.
  assert.doesNotMatch(script, /OPERATOR_SUI_PRIVATE_KEY/);
  assert.doesNotMatch(script, /signAndExecuteTransaction|executeTransaction|signTransaction|signPersonalMessage/);
  assert.doesNotMatch(script, /@mysten\/sui\/keypairs|decodeSuiPrivateKey|Ed25519Keypair|Secp256k1Keypair|Secp256r1Keypair/);
  // Nothing is written either: the old --execute left a bundle under .tmp/.
  assert.doesNotMatch(script, /writeFileSync|mkdirSync/);

  // The environment is read through env() alone.
  assert.equal(script.match(/process\.env/g)?.length, 1, 'process.env is read only by env()');
  assert.match(script, /\nconst env = \(k\) => \(process\.env\[k\] \?\? ''\)\.trim\(\);\n/);

  // --execute is gone, and any argument stops with a pointer to the executed proof.
  assert.doesNotMatch(script, /args\.includes\('--execute'\)|\bEXECUTE\b/);
  assert.match(script, /for \(const arg of args\) \{\s*stop\(/);
  assert.match(script, /experiments\/v2-phase1\/testnet-e2e\.mjs/);

  // Every transaction goes through simulate(), which builds and simulates.
  const simulateBody = functionBody(script, 'simulate');
  assert.match(simulateBody, /tx\.build\(\{ client \}\)/);
  assert.match(simulateBody, /client\.core\.simulateTransaction\(/);
  assert.equal(script.match(/new Transaction\(\)/g)?.length, script.match(/await simulate\(/g)?.length, 'each transaction built is simulated');

  // main runs the configuration checks before any simulation.
  const main = functionBody(script, 'main');
  const order = [
    'await checkChain()',
    'await checkIds()',
    'await checkAbi()',
    "gated('Peg refresh (simulated)'",
    "gated('Audit anchor (simulated)'",
    "gated('Wallet payment (simulated)'",
    "gated('Operator refused (simulated)'",
  ].map((marker) => {
    assert.ok(main.includes(marker), `main runs ${marker}`);
    return main.indexOf(marker);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'main checks the ids and signatures before it simulates');

  // The chain id, not SUI_NETWORK alone, decides which network answered.
  assert.match(script, /testnet: '4c78adac'/);
  assert.match(functionBody(script, 'checkChain'), /if \(chainId !== CHAIN_IDS\[NETWORK\]\) \{\s*refuse\(/);
});

test('the payment runs as the business wallet with the operator paying gas, and the operator alone is refused', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  // The constants the checks rely on are the source's.
  const kind = /\nconst KIND_WALLET = (\d+);/.exec(script);
  assert.ok(kind, 'the script names KIND_WALLET');
  assert.equal(Number(kind[1]), await moveConstant('payment_intent', 'KIND_WALLET'));
  const notWallet = /\nconst E_NOT_THE_WALLET = (\d+);/.exec(script);
  assert.ok(notWallet, 'the script names E_NOT_THE_WALLET');
  assert.equal(Number(notWallet[1]), await moveConstant('business_account', 'E_NOT_THE_WALLET'));

  // The wallet path: the sender is the account's registered wallet, read from
  // the chain, and the operator only pays gas.
  const payment = functionBody(script, 'checkWalletPaymentSimulated');
  assert.match(payment, /const wallet = await verifyWallet\(\);/);
  assert.match(payment, /simulate\('the wallet payment', tx, \{ sender: wallet, gasOwner: OPERATOR \}\)/);
  assert.match(payment, /tx\.withdrawal\(\{ amount: PAYMENT_MINOR, type: USDC \}\)/);
  for (const event of ['payment_intent::IntentCreated', 'payment_intent::IntentConfirmed', 'audit_anchor::SettlementAnchored']) {
    assert.ok(payment.includes(`'${event}'`), `the payment check expects ${event}`);
  }
  assert.match(functionBody(script, 'verifyWallet'), /account\.json\?\.wallet/);

  // The refusal: the same create, as the operator, must abort in
  // business_account with E_NOT_THE_WALLET, on this package.
  const refusal = functionBody(script, 'checkOperatorRefused');
  assert.match(refusal, /await simulate\('create_for_wallet as the operator', tx\);/);
  assert.match(refusal, /abort\.package !== PACKAGE \|\| abort\.module !== 'business_account' \|\| abort\.code !== E_NOT_THE_WALLET/);

  // Without a verify account both are reported as skipped, never as passed.
  const main = functionBody(script, 'main');
  assert.match(main, /record\('Wallet payment \(simulated\)', 'SKIP', why\);/);
  assert.match(main, /record\('Operator refused \(simulated\)', 'SKIP', why\);/);
  assert.match(main, /skipped\.length \? `, \$\{skipped\.length\} skipped` : ''/);
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
