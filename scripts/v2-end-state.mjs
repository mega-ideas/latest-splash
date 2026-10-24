/**
 * v2-end-state — D11's end state, read from the chain.
 *
 * D11: splash_spend and splash_upgrade_delay are published immutable, and
 * splash_core's UpgradeCap sits in the 24-hour DelayedUpgradeCap, additive
 * (128), owned by the governance multisig. scripts/e2e-testnet.mjs (the
 * ceremony's verify step) runs these checks; they live here so the tests can
 * run them against a mocked node.
 *
 * Every function only reads: getObject, getTransaction and the package
 * version listing. Nothing here holds a key or builds a transaction.
 *
 * What "immutable" means on chain. A package object is always an immutable
 * object; what makes it upgradeable is its UpgradeCap, and the chain keeps no
 * index from a package to its cap. So the checks read the publish transaction
 * itself (the package's previous transaction):
 *
 *   - it must create no UpgradeCap that outlives it. A cap that was made
 *     immutable, or used, in a LATER transaction left a window in which one
 *     key could upgrade the package, and the chain cannot show what happened
 *     in it beyond the version list;
 *   - it must be exactly Publish, then 0x2::package::make_immutable. A cap
 *     created and wrapped in the same transaction never appears in its
 *     effects; with no other command, and an UpgradeCap that has no drop, the
 *     cap Publish returned can only have gone to make_immutable;
 *   - every object it created must come back typed, so an UpgradeCap among
 *     them cannot hide behind a node that left the type out;
 *   - the package must be version 1 with no later versions.
 *
 * Every check fails closed: what the node does not return counts against the
 * end state, and an id that is not configured is SKIP, never PASS.
 *
 * It does not compare the on-chain modules with the audited build, check
 * splash_spend's linkage, or read the ComplianceConfig's registries.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

/** 0x2::package policies: compatible, additive, dependency-only. */
export const COMPATIBLE_POLICY = 0;
export const ADDITIVE_POLICY = 128;
export const DEP_ONLY_POLICY = 192;

const UPGRADE_CAP_TYPE = normalizeType('0x2::package::UpgradeCap');
const MAKE_IMMUTABLE = `${normalizeSuiAddress('0x2')}::package::make_immutable`;
/** Pages of package versions read before giving up; 1000 versions a page. */
const MAX_VERSION_PAGES = 20;

/** `0x2::package::UpgradeCap` and `0x000…002::package::UpgradeCap` name the same type. */
function normalizeType(type) {
  const [address, ...rest] = String(type ?? '').split('::');
  return rest.length ? [normalizeSuiAddress(address), ...rest].join('::') : String(type ?? '');
}

const message = (e) => (e instanceof Error ? e.message : String(e));
const notFound = (e) => e?.reason === 'notFound' || e?.code === 'notExists' || e?.code === 'NOT_FOUND';

/**
 * Whether an UpgradeCap the operator owns might be `packageId`'s. A cap whose
 * package the node did not return counts as this one: the custody check must
 * not pass on what it could not read.
 */
export function isUpgradeCapFor(object, packageId) {
  const named = object?.json?.package;
  if (typeof named !== 'string' || !named) return true;
  return normalizeSuiAddress(named) === normalizeSuiAddress(packageId);
}

async function readObject(node, objectId, include) {
  try {
    return { object: (await node.core.getObject({ objectId, include })).object };
  } catch (e) {
    return { missing: notFound(e), error: message(e) };
  }
}

/** Every version of the package `packageId` belongs to, oldest first. */
async function packageVersions(node, packageId) {
  const versions = [];
  let pageToken;
  for (let page = 0; page < MAX_VERSION_PAGES; page += 1) {
    const { response } = await node.movePackageService.listPackageVersions({ packageId, ...(pageToken ? { pageToken } : {}) });
    versions.push(...(response?.versions ?? []));
    pageToken = response?.nextPageToken?.length ? response.nextPageToken : undefined;
    if (!pageToken) return versions;
  }
  throw new Error(`more than ${MAX_VERSION_PAGES} pages of versions`);
}

function asBigInt(value) {
  try {
    return value === undefined || value === null || value === '' ? null : BigInt(value);
  } catch {
    return null;
  }
}

function describeCommand(command) {
  if (command?.$kind === 'MoveCall') {
    const c = command.MoveCall ?? {};
    return `${normalizeSuiAddress(String(c.package ?? '0x0'))}::${c.module}::${c.function}`;
  }
  return String(command?.$kind ?? 'an unknown command');
}

/** What is wrong with the version list of `packageId`, or nothing. */
async function versionProblems(node, packageId) {
  let versions;
  try {
    versions = await packageVersions(node, packageId);
  } catch (e) {
    return [`its versions could not be listed: ${message(e)}`];
  }
  if (!versions.length) return ['the node lists no versions of it, so a later version cannot be ruled out'];
  const problems = [];
  const self = versions.find((v) => v.packageId && normalizeSuiAddress(v.packageId) === packageId);
  const selfVersion = asBigInt(self?.version);
  if (selfVersion !== 1n) {
    problems.push(`it is version ${self?.version ?? 'unknown'}, not the original: the id must be the package as first published (version 1)`);
  }
  const later = versions.filter((v) => asBigInt(v.version) !== 1n && !(v.packageId && normalizeSuiAddress(v.packageId) === packageId));
  if (later.length) {
    problems.push(`it has been upgraded: ${later.map((v) => `${v.packageId} (version ${v.version})`).join(', ')}`);
  }
  return problems;
}

/** What is wrong with the transaction that published `packageId`, or nothing. */
async function publishProblems(node, digest, packageId) {
  let t;
  try {
    const res = await node.core.getTransaction({ digest, include: { effects: true, objectTypes: true, transaction: true } });
    t = res?.$kind === 'Transaction' ? res.Transaction : null;
    if (!t) return [`its publish transaction ${digest} did not succeed`];
  } catch (e) {
    return [`its publish transaction ${digest} could not be read: ${message(e)}`];
  }
  const problems = [];

  const changed = t.effects?.changedObjects;
  if (!Array.isArray(changed)) return [`the node returned no effects for its publish transaction ${digest}`];
  if (!changed.some((o) => o.objectId && normalizeSuiAddress(o.objectId) === packageId && o.outputState === 'PackageWrite')) {
    problems.push(`${digest}, its previous transaction, did not publish it`);
  }
  const types = t.objectTypes ?? {};
  const created = changed.filter((o) => o.idOperation === 'Created' && o.outputState !== 'PackageWrite');
  const untyped = created.filter((o) => !types[o.objectId]);
  if (untyped.length) {
    problems.push(
      `the node did not give the type of ${untyped.map((o) => o.objectId).join(', ')}, created by the publish ${digest}, so an UpgradeCap among them cannot be ruled out`,
    );
  }
  for (const cap of created.filter((o) => types[o.objectId] && normalizeType(types[o.objectId]) === UPGRADE_CAP_TYPE)) {
    const read = await readObject(node, cap.objectId);
    if (read.object) {
      const owner = read.object.owner?.AddressOwner ?? read.object.owner?.ObjectOwner ?? read.object.owner?.$kind ?? 'no one';
      problems.push(
        `the publish ${digest} left UpgradeCap ${cap.objectId}, which still exists (held by ${owner}): whoever holds it can upgrade the package. D11 publishes and makes immutable in one transaction`,
      );
    } else {
      problems.push(
        `the publish ${digest} left UpgradeCap ${cap.objectId}, which ${read.missing ? 'is no longer an object of its own (made immutable, deleted or wrapped since)' : `could not be read (${read.error})`}; it outlived the publish, so for a while whoever held it could upgrade the package. D11 publishes and makes immutable in one transaction`,
      );
    }
  }

  const commands = t.transaction?.commands;
  if (!Array.isArray(commands)) {
    problems.push(`the node did not return the commands of the publish ${digest}, so a command that kept the UpgradeCap cannot be ruled out`);
  } else {
    const exact = commands.length === 2 && commands[0]?.$kind === 'Publish' && describeCommand(commands[1]) === MAKE_IMMUTABLE;
    if (!exact) {
      problems.push(
        `the publish ${digest} ran ${commands.map(describeCommand).join(', ') || 'no commands'}, not exactly Publish then 0x2::package::make_immutable, so a command that kept or wrapped the UpgradeCap cannot be ruled out`,
      );
    }
  }
  return problems;
}

/**
 * `packageId` can never be upgraded: version 1, no later version, and
 * published and made immutable in one transaction. A record for the verify
 * script: { check, status, detail }.
 */
export async function checkImmutablePackage(node, { label, envKey, packageId }) {
  const result = (status, detail) => ({ check: label, status, detail });
  if (!packageId) return result('SKIP', `skipped: set ${envKey} to check that the package can never be upgraded.`);
  const id = normalizeSuiAddress(packageId);

  const read = await readObject(node, id, { previousTransaction: true });
  if (!read.object) {
    return result('FAIL', read.missing ? `${envKey} ${id} does not exist on this chain.` : `${envKey} ${id} could not be read: ${read.error}`);
  }
  if (read.object.type !== 'package') return result('FAIL', `${envKey} is a ${read.object.type || 'object of no type'}, not a package.`);

  const problems = await versionProblems(node, id);
  const digest = read.object.previousTransaction;
  if (!digest) {
    problems.push('the node did not say which transaction published it, so its UpgradeCap cannot be traced');
  } else {
    problems.push(...(await publishProblems(node, digest, id)));
  }
  if (problems.length) return result('FAIL', `${envKey} ${id}: ${problems.join('; ')}.`);
  return result('PASS', `${id}: version 1, no later version, published and made immutable in one transaction (${digest}).`);
}

function wrapperJson(object) {
  const json = object?.json;
  return json && typeof json === 'object' ? json : null;
}

/**
 * Core's UpgradeCap in the canonical DelayedUpgradeCap, additive, and the
 * wrapper held by the governance multisig. Two records: 'Upgrade wrapper' and
 * 'Upgrade wrapper owner'.
 */
export async function checkUpgradeWrapper(node, { wrapperId, delayPackageId, corePackageId, governance, operator }) {
  const W = 'Upgrade wrapper';
  const O = 'Upgrade wrapper owner';
  if (!wrapperId) {
    const why = "skipped: set SPLASH_UPGRADE_WRAPPER_ID to the DelayedUpgradeCap that holds splash_core's UpgradeCap.";
    return [
      { check: W, status: 'SKIP', detail: why },
      { check: O, status: 'SKIP', detail: why },
    ];
  }
  const id = normalizeSuiAddress(wrapperId);
  const read = await readObject(node, id, { json: true });
  if (!read.object) {
    const detail = read.missing
      ? `SPLASH_UPGRADE_WRAPPER_ID ${id} does not exist on this chain.`
      : `SPLASH_UPGRADE_WRAPPER_ID ${id} could not be read: ${read.error}`;
    return [
      { check: W, status: 'FAIL', detail },
      { check: O, status: 'FAIL', detail: `not checked: ${detail}` },
    ];
  }
  const object = read.object;
  const core = corePackageId ? normalizeSuiAddress(corePackageId) : '';

  // The wrapper.
  const problems = [];
  const notes = [];
  const type = normalizeType(object.type);
  const expected = delayPackageId ? `${normalizeSuiAddress(delayPackageId)}::upgrade_delay::DelayedUpgradeCap` : null;
  const wrongType = expected ? type !== expected : !type.endsWith('::upgrade_delay::DelayedUpgradeCap');
  if (wrongType) {
    problems.push(
      `it is a ${object.type || 'object of no type'}, not a ${expected ?? 'DelayedUpgradeCap'}: only the canonical splash_upgrade_delay keeps core behind the 24-hour notice`,
    );
  }
  let policy = null;
  let version = null;
  const json = wrapperJson(object);
  if (!json) {
    problems.push('the node did not return its contents, so the cap inside cannot be checked');
  } else {
    const original = typeof json.original_package === 'string' ? normalizeSuiAddress(json.original_package) : null;
    if (!core) problems.push('no splash_core package id to compare it with');
    else if (original !== core) problems.push(`it wraps the UpgradeCap of ${json.original_package ?? 'no package'}, not splash_core ${core}`);
    const cap = json.cap && typeof json.cap === 'object' ? json.cap : null;
    if (!cap) {
      problems.push('it holds no UpgradeCap the node could read');
    } else {
      version = asBigInt(cap.version);
      if (version === null || version < 1n) problems.push(`its cap's version is unreadable (${cap.version})`);
      else if (version === 1n && core && (typeof cap.package !== 'string' || normalizeSuiAddress(cap.package) !== core)) {
        problems.push(`its cap, at version 1, is for ${cap.package ?? 'no package'}, not splash_core ${core}`);
      } else if (version > 1n) {
        notes.push(`upgraded through it to version ${version} (${cap.package})`);
      }
      policy = Number(cap.policy);
      if (!Number.isInteger(policy)) {
        problems.push(`its cap's policy is unreadable (${cap.policy})`);
      } else if (policy < ADDITIVE_POLICY) {
        problems.push(
          `its cap's policy is ${policy}, looser than additive (${ADDITIVE_POLICY}): an upgrade could change existing functions. D11 is additive`,
        );
      } else if (policy !== ADDITIVE_POLICY && policy !== DEP_ONLY_POLICY) {
        problems.push(`its cap's policy is ${policy}, which is not a policy 0x2::package defines`);
      }
    }
    if (json.pending) notes.push('an upgrade is announced and pending');
    if (json.pending_owner) notes.push('a change of owner is announced and pending');
  }
  const tail = notes.length ? ` Note: ${notes.join('; ')}.` : '';
  let wrapper;
  if (problems.length) {
    wrapper = { check: W, status: 'FAIL', detail: `SPLASH_UPGRADE_WRAPPER_ID ${id}: ${problems.join('; ')}.${tail}` };
  } else if (!expected) {
    wrapper = {
      check: W,
      status: 'SKIP',
      detail: `skipped: ${id} wraps splash_core's UpgradeCap with policy ${policy}, but set SPLASH_UPGRADE_DELAY_PACKAGE_ID to check it is the canonical splash_upgrade_delay's.${tail}`,
    };
  } else if (policy === DEP_ONLY_POLICY) {
    wrapper = {
      check: W,
      status: 'WARN',
      detail: `${id} holds splash_core's UpgradeCap with policy dependency-only (${DEP_ONLY_POLICY}), stricter than D11's additive (${ADDITIVE_POLICY}): core can only change its dependencies.${tail}`,
    };
  } else {
    wrapper = {
      check: W,
      status: 'PASS',
      detail: `${id} holds splash_core's UpgradeCap (version ${version}), policy additive (${ADDITIVE_POLICY}), behind the 24-hour notice.${tail}`,
    };
  }

  // Who holds it.
  let owner;
  const holder = object.owner?.$kind === 'AddressOwner' ? normalizeSuiAddress(object.owner.AddressOwner) : null;
  const hot = operator ? normalizeSuiAddress(operator) : '';
  const multisig = governance ? normalizeSuiAddress(governance) : '';
  if (wrongType) {
    owner = { check: O, status: 'FAIL', detail: `not checked: SPLASH_UPGRADE_WRAPPER_ID ${id} is not the wrapper.` };
  } else if (!holder) {
    owner = { check: O, status: 'FAIL', detail: `${id} is not owned by an address (${object.owner?.$kind ?? 'no owner returned'}).` };
  } else if (hot && holder === hot) {
    owner = {
      check: O,
      status: 'FAIL',
      detail: `${id} is held by the operator ${holder}, a single hot key: it could propose and run a core upgrade alone. Move it to the governance multisig (propose_owner_change).`,
    };
  } else if (!multisig) {
    owner = { check: O, status: 'SKIP', detail: `skipped: ${id} is held by ${holder}; set SPLASH_GOVERNANCE_ADDRESS to the governance multisig to check it is that.` };
  } else if (holder !== multisig) {
    owner = { check: O, status: 'FAIL', detail: `${id} is held by ${holder}, not the governance multisig ${multisig}.` };
  } else {
    owner = { check: O, status: 'PASS', detail: `${id} is held by the governance multisig ${holder}.` };
  }
  return [wrapper, owner];
}
