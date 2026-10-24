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
    'SPLASH_FEE_CONFIG_ID',
    'SPLASH_ADDRESS_REGISTRY_ID',
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
  assert.equal(Number(kind[1]), await moveConstant('fee_config', 'KIND_WALLET'));
  const notWallet = /\nconst E_NOT_THE_WALLET = (\d+);/.exec(script);
  assert.ok(notWallet, 'the script names E_NOT_THE_WALLET');
  assert.equal(Number(notWallet[1]), await moveConstant('business_account', 'E_NOT_THE_WALLET'));

  // The wallet path: the sender is the account's registered wallet, read from
  // the chain, and the operator only pays gas.
  const payment = functionBody(script, 'checkWalletPaymentSimulated');
  assert.match(payment, /const wallet = await verifyWallet\(\);/);
  assert.match(payment, /simulate\('the wallet payment', tx, \{ sender: wallet, gasOwner: OPERATOR \}\)/);
  // A1 §2.6: the wallet draws the payment and the most its fee can be, and
  // passes that bound as max_fee; core returns the unused part to the wallet.
  assert.match(payment, /tx\.withdrawal\(\{ amount: PAYMENT_MINOR \+ MAX_FEE_MINOR, type: USDC \}\)/);
  assert.match(payment, /tx\.object\(FEE_CONFIG\),\s*tx\.object\(ADDRESS_REGISTRY\),\s*payment,\s*tx\.pure\.u64\(MAX_FEE_MINOR\),/);
  assert.match(script, /\nconst MAX_FEE_MINOR = PAYMENT_MINOR \/ 100;\n/);
  assert.equal(await moveConstant('fee_config', 'FEE_CEILING_BPS'), 100, 'MAX_FEE_MINOR is the 100 bps ceiling');
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

// ─── D11's end state (review, Oct 2026) ─────────────────────────────────────
//
// D11: splash_spend and splash_upgrade_delay are published immutable, and
// core's UpgradeCap sits in the 24-hour DelayedUpgradeCap, additive (128),
// owned by the governance multisig. The verify script checked none of it:
// it reported "UpgradeCap custody" PASS whenever the operator did not hold
// the cap, and its filter passed a cap whose contents the node did not
// return. The checks live in scripts/v2-end-state.mjs, read-only, so they can
// be run here against a mocked node.

const END_STATE = '../scripts/v2-end-state.mjs';
const UPGRADE_CAP = '0x2::package::UpgradeCap';
const results = JSON.parse(await source('experiments/v2-phase1/testnet-e2e-results.json'));
const CORE = results.steps.publishCore.packageId;
const SPEND = results.steps.publishSpend.packageId;
const DELAY = results.steps.publishDelay.packageId;
const WRAPPER = results.steps.wrap.wrapper;
const GOVERNANCE = results.signers.governance;
const OPERATOR = `0x${'5'.repeat(64)}`;

/**
 * A node that answers the three reads the end-state checks make, built from
 * the testnet run (testnet-e2e.mjs published both packages with
 * make_immutable in the publish transaction, and governance wrapped the core
 * cap). `change` edits the world before it is served.
 */
function mockNode(change = (w) => w) {
  const publish = (digest, pkg, created = []) => ({
    digest,
    effects: {
      changedObjects: [
        { objectId: pkg, idOperation: 'Created', outputState: 'PackageWrite' },
        ...created.map((o) => ({ objectId: o.id, idOperation: 'Created', outputState: 'ObjectWrite' })),
      ],
    },
    objectTypes: Object.fromEntries(created.map((o) => [o.id, o.type])),
    transaction: {
      commands: [
        { $kind: 'Publish', Publish: {} },
        { $kind: 'MoveCall', MoveCall: { package: '0x2', module: 'package', function: 'make_immutable' } },
      ],
    },
  });
  const world = change({
    objects: {
      [SPEND]: { objectId: SPEND, type: 'package', owner: { $kind: 'Immutable' }, previousTransaction: results.steps.publishSpend.digest },
      [DELAY]: { objectId: DELAY, type: 'package', owner: { $kind: 'Immutable' }, previousTransaction: results.steps.publishDelay.digest },
      [WRAPPER]: {
        objectId: WRAPPER,
        type: `${DELAY}::upgrade_delay::DelayedUpgradeCap`,
        owner: { $kind: 'AddressOwner', AddressOwner: GOVERNANCE },
        json: { id: WRAPPER, cap: { id: results.steps.publishCore.upgradeCap, package: CORE, version: '1', policy: 128 }, original_package: CORE, pending: null, pending_owner: null },
      },
    },
    versions: { [SPEND]: [{ packageId: SPEND, version: 1n }], [DELAY]: [{ packageId: DELAY, version: 1n }] },
    transactions: {
      [results.steps.publishSpend.digest]: publish(results.steps.publishSpend.digest, SPEND, [
        { id: results.steps.publishSpend.policyRegistry, type: `${SPEND}::spend_policy::PolicyRegistry` },
      ]),
      [results.steps.publishDelay.digest]: publish(results.steps.publishDelay.digest, DELAY),
    },
  });
  const notFound = (what) => Object.assign(new Error(`${what} not found`), { code: 'NOT_FOUND' });
  return {
    core: {
      async getObject({ objectId, include = {} }) {
        const o = world.objects[objectId];
        if (!o) throw notFound(objectId);
        return { object: { ...o, json: include.json ? (o.json ?? null) : undefined } };
      },
      async getTransaction({ digest }) {
        const t = world.transactions[digest];
        if (!t) throw notFound(digest);
        return { $kind: 'Transaction', Transaction: t };
      },
    },
    movePackageService: {
      async listPackageVersions({ packageId }) {
        return { response: { versions: world.versions[packageId] ?? [] } };
      },
    },
  };
}

const wrapperInput = (over = {}) => ({ wrapperId: WRAPPER, delayPackageId: DELAY, corePackageId: CORE, governance: GOVERNANCE, operator: OPERATOR, ...over });
const byCheck = (records) => Object.fromEntries(records.map((r) => [r.check, r]));

test('the verify script checks D11 end state with the v2 ids, and reports an unset id skipped, never passed', async () => {
  const script = await source('scripts/e2e-testnet.mjs');
  for (const key of ['SPLASH_SPEND_PACKAGE_ID', 'SPLASH_UPGRADE_DELAY_PACKAGE_ID', 'SPLASH_UPGRADE_WRAPPER_ID', 'SPLASH_GOVERNANCE_ADDRESS']) {
    assert.ok(script.includes(`'${key}'`), `scripts/e2e-testnet.mjs reads ${key}`);
  }
  const main = functionBody(script, 'main');
  assert.ok(main.includes('await checkEndState()'), 'main checks the end state');
  assert.ok(main.indexOf('await checkIds()') < main.indexOf('await checkEndState()'));
  assert.ok(main.indexOf('await checkEndState()') < main.indexOf('await checkAbi()'), 'before anything is simulated');

  const { checkImmutablePackage, checkUpgradeWrapper } = await import(END_STATE);
  const node = mockNode();
  const spend = await checkImmutablePackage(node, { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: '' });
  assert.equal(spend.status, 'SKIP');
  assert.match(spend.detail, /SPLASH_SPEND_PACKAGE_ID/);
  for (const r of await checkUpgradeWrapper(node, wrapperInput({ wrapperId: '' }))) {
    assert.equal(r.status, 'SKIP', `${r.check} is skipped without SPLASH_UPGRADE_WRAPPER_ID`);
  }
  const owner = byCheck(await checkUpgradeWrapper(node, wrapperInput({ governance: '' })));
  assert.equal(owner['Upgrade wrapper owner'].status, 'SKIP', 'the owner is not passed without the governance address to compare');
  assert.match(owner['Upgrade wrapper owner'].detail, /SPLASH_GOVERNANCE_ADDRESS/);
  const untyped = byCheck(await checkUpgradeWrapper(node, wrapperInput({ delayPackageId: '' })));
  assert.equal(untyped['Upgrade wrapper'].status, 'SKIP', 'the wrapper is not passed without the canonical package to pin its type to');
  assert.match(untyped['Upgrade wrapper'].detail, /SPLASH_UPGRADE_DELAY_PACKAGE_ID/);
  // Untyped, the object may be a look-alike from any package, so who holds it
  // is not passed either.
  assert.equal(untyped['Upgrade wrapper owner'].status, 'SKIP', 'the owner of an unpinned wrapper is not passed');
  assert.match(untyped['Upgrade wrapper owner'].detail, /SPLASH_UPGRADE_DELAY_PACKAGE_ID/);
});

test("the testnet run's packages and wrapper pass the end-state checks", async () => {
  const { checkImmutablePackage, checkUpgradeWrapper } = await import(END_STATE);
  const node = mockNode();
  for (const [label, envKey, packageId] of [
    ['splash_spend immutable', 'SPLASH_SPEND_PACKAGE_ID', SPEND],
    ['splash_upgrade_delay immutable', 'SPLASH_UPGRADE_DELAY_PACKAGE_ID', DELAY],
  ]) {
    const r = await checkImmutablePackage(node, { label, envKey, packageId });
    assert.equal(r.status, 'PASS', `${label}: ${r.detail}`);
  }
  const wrapper = byCheck(await checkUpgradeWrapper(node, wrapperInput()));
  assert.equal(wrapper['Upgrade wrapper'].status, 'PASS', wrapper['Upgrade wrapper'].detail);
  assert.match(wrapper['Upgrade wrapper'].detail, /128/);
  assert.equal(wrapper['Upgrade wrapper owner'].status, 'PASS', wrapper['Upgrade wrapper owner'].detail);
});

test('a splash_spend that has a later version fails', async () => {
  const { checkImmutablePackage } = await import(END_STATE);
  const later = `0x${'7'.repeat(64)}`;
  const node = mockNode((w) => ({ ...w, versions: { ...w.versions, [SPEND]: [{ packageId: SPEND, version: 1n }, { packageId: later, version: 2n }] } }));
  const r = await checkImmutablePackage(node, { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: SPEND });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, new RegExp(later));
});

test('an UpgradeCap that survived the publish transaction fails, whether or not it still exists', async () => {
  const { checkImmutablePackage } = await import(END_STATE);
  const cap = `0x${'c'.repeat(64)}`;
  const leaveCap = (alive) => (w) => {
    const t = w.transactions[results.steps.publishSpend.digest];
    t.effects.changedObjects.push({ objectId: cap, idOperation: 'Created', outputState: 'ObjectWrite' });
    t.objectTypes[cap] = UPGRADE_CAP;
    t.transaction.commands = t.transaction.commands.filter((c) => c.$kind !== 'MoveCall');
    if (alive) w.objects[cap] = { objectId: cap, type: UPGRADE_CAP, owner: { $kind: 'AddressOwner', AddressOwner: OPERATOR } };
    return w;
  };
  const input = { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: SPEND };
  const alive = await checkImmutablePackage(mockNode(leaveCap(true)), input);
  assert.equal(alive.status, 'FAIL');
  assert.match(alive.detail, new RegExp(`${cap}.*exists`));
  const gone = await checkImmutablePackage(mockNode(leaveCap(false)), input);
  assert.equal(gone.status, 'FAIL', 'a cap made immutable in a later transaction leaves an upgrade window the chain cannot rule out');
  assert.match(gone.detail, /one transaction/);
});

test('a publish transaction whose created objects the node does not type fails closed', async () => {
  const { checkImmutablePackage } = await import(END_STATE);
  const node = mockNode((w) => {
    w.transactions[results.steps.publishSpend.digest].objectTypes = {};
    return w;
  });
  const r = await checkImmutablePackage(node, { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: SPEND });
  assert.equal(r.status, 'FAIL');
});

test('a publish transaction that runs anything but Publish then make_immutable fails: it could have kept the cap', async () => {
  const { checkImmutablePackage } = await import(END_STATE);
  const input = { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: SPEND };
  // A cap created and wrapped in the same transaction never shows in its
  // effects, so only the commands rule that out.
  const kept = mockNode((w) => {
    w.transactions[results.steps.publishSpend.digest].transaction.commands[1] = {
      $kind: 'MoveCall',
      MoveCall: { package: `0x${'e'.repeat(64)}`, module: 'vault', function: 'keep' },
    };
    return w;
  });
  const r = await checkImmutablePackage(kept, input);
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /vault::keep/);
  const unread = mockNode((w) => {
    delete w.transactions[results.steps.publishSpend.digest].transaction;
    return w;
  });
  assert.equal((await checkImmutablePackage(unread, input)).status, 'FAIL', 'a publish whose commands the node does not return fails closed');
});

test('a wrapper with a looser policy, around another package, or held by anyone but governance fails', async () => {
  const { checkUpgradeWrapper, ADDITIVE_POLICY } = await import(END_STATE);
  assert.equal(ADDITIVE_POLICY, 128);
  const withJson = (patch) => (w) => {
    w.objects[WRAPPER].json = { ...w.objects[WRAPPER].json, ...patch(w.objects[WRAPPER].json) };
    return w;
  };
  const compatible = byCheck(await checkUpgradeWrapper(mockNode(withJson((j) => ({ cap: { ...j.cap, policy: 0 } }))), wrapperInput()));
  assert.equal(compatible['Upgrade wrapper'].status, 'FAIL');
  assert.match(compatible['Upgrade wrapper'].detail, /\b0\b.*128|128.*\b0\b/);

  const other = byCheck(await checkUpgradeWrapper(mockNode(withJson(() => ({ original_package: SPEND }))), wrapperInput()));
  assert.equal(other['Upgrade wrapper'].status, 'FAIL');

  const stranger = `0x${'d'.repeat(64)}`;
  const heldBy = (address) => (w) => {
    w.objects[WRAPPER].owner = { $kind: 'AddressOwner', AddressOwner: address };
    return w;
  };
  const elsewhere = byCheck(await checkUpgradeWrapper(mockNode(heldBy(stranger)), wrapperInput()));
  assert.equal(elsewhere['Upgrade wrapper owner'].status, 'FAIL');
  assert.match(elsewhere['Upgrade wrapper owner'].detail, new RegExp(stranger));
  // The operator is a single hot key: a failure even with no governance address to compare.
  const hot = byCheck(await checkUpgradeWrapper(mockNode(heldBy(OPERATOR)), wrapperInput({ governance: '' })));
  assert.equal(hot['Upgrade wrapper owner'].status, 'FAIL');
  const sameKey = byCheck(await checkUpgradeWrapper(mockNode(heldBy(OPERATOR)), wrapperInput({ governance: OPERATOR })));
  assert.equal(sameKey['Upgrade wrapper owner'].status, 'FAIL', 'the operator is never the governance multisig');

  // Dependency-only (192) is stricter than D11 asks: reported, not failed.
  const depOnly = byCheck(await checkUpgradeWrapper(mockNode(withJson((j) => ({ cap: { ...j.cap, policy: 192 } }))), wrapperInput()));
  assert.equal(depOnly['Upgrade wrapper'].status, 'WARN', depOnly['Upgrade wrapper'].detail);
  // A core upgraded through the wrapper: its cap names the latest version,
  // the wrapper still names the original.
  const upgraded = byCheck(
    await checkUpgradeWrapper(mockNode(withJson((j) => ({ cap: { ...j.cap, package: `0x${'8'.repeat(64)}`, version: '2' } }))), wrapperInput()),
  );
  assert.equal(upgraded['Upgrade wrapper'].status, 'PASS', upgraded['Upgrade wrapper'].detail);
  assert.match(upgraded['Upgrade wrapper'].detail, /version 2/);

  const wrongType = byCheck(await checkUpgradeWrapper(mockNode(), wrapperInput({ delayPackageId: SPEND })));
  assert.equal(wrongType['Upgrade wrapper'].status, 'FAIL', 'a DelayedUpgradeCap of another package is not the canonical wrapper');

  const unread = byCheck(await checkUpgradeWrapper(mockNode((w) => ({ ...w, objects: { ...w.objects, [WRAPPER]: { ...w.objects[WRAPPER], json: null } } })), wrapperInput()));
  assert.equal(unread['Upgrade wrapper'].status, 'FAIL', 'a wrapper whose contents the node does not return fails closed');
});

test('an UpgradeCap whose contents the node does not return counts as held', async () => {
  const { isUpgradeCapFor } = await import(END_STATE);
  assert.equal(isUpgradeCapFor({ objectId: '0x1', json: { package: CORE } }, CORE), true);
  assert.equal(isUpgradeCapFor({ objectId: '0x1', json: { package: SPEND } }, CORE), false);
  assert.equal(isUpgradeCapFor({ objectId: '0x1', json: null }, CORE), true, 'fail closed: the cap might be core');
  assert.equal(isUpgradeCapFor({ objectId: '0x1' }, CORE), true);
  const script = await source('scripts/e2e-testnet.mjs');
  assert.match(script, /\(o\) => isUpgradeCapFor\(o, PACKAGE\)/, 'the UpgradeCap custody check uses it');
});

test('the end-state module only reads: no key, no signing, no transaction', async () => {
  const text = await source('scripts/v2-end-state.mjs');
  assert.doesNotMatch(text, /signAndExecuteTransaction|executeTransaction|signTransaction|signPersonalMessage|simulateTransaction/);
  assert.doesNotMatch(text, /@mysten\/sui\/keypairs|decodeSuiPrivateKey|Keypair|new Transaction\(/);
  assert.doesNotMatch(text, /process\.env|writeFileSync|mkdirSync/);
});
