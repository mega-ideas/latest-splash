// Pre-audit C1 (13 Nov 2026): settlement evidence on Walrus must outlive the
// publisher's defaults. A `PUT /v1/blobs` with no parameters buys ONE epoch
// (two weeks on Mainnet) and, since Walrus 1.33, a DELETABLE blob whose Blob
// object stays with whoever runs the publisher. Audit anchors would then point
// at evidence that is gone in two weeks, or that someone else can delete.
//
// Publisher API, as documented at https://docs.wal.app/usage/web-api.html
// ("Storing Blobs"): `epochs`, `permanent=true`, `send_object_to`; the
// response is either `newlyCreated.blobObject` (with `storage.startEpoch`,
// `storage.endEpoch` and `deletable`) or `alreadyCertified` (with `endEpoch`
// directly under it). The most epochs storage can be bought for is 53 on
// Mainnet and Testnet (https://docs.wal.app/usage/networks.html).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

// A namespace import, so each test fails on its own claim if a helper is missing.
import * as walrus from '../lib/server/walrus.ts';

const { WALRUS_MAX_EPOCHS, retrieveBlob, storeEncryptedInvoice, walrusStoreEpochs, walrusStoreUrl } = walrus;

const OWNER = `0x${'ab'.repeat(32)}`;
const CIPHERTEXT = 'c2VhbGVkLWNpcGhlcnRleHQ=';

/* ── The store URL ───────────────────────────────────────────────────── */

test('the network maximum is 53 epochs, as Walrus documents it', () => {
  assert.equal(WALRUS_MAX_EPOCHS, 53);
});

test('a store asks for the network maximum, as a permanent blob, by default', () => {
  const url = new URL(walrusStoreUrl('https://publisher.example/', {}));
  assert.equal(url.pathname, '/v1/blobs');
  assert.equal(url.searchParams.get('epochs'), String(WALRUS_MAX_EPOCHS));
  assert.equal(url.searchParams.get('permanent'), 'true');
  // `deletable` is deprecated and, sent with `permanent=true`, is an
  // INVALID_BLOB_PERSISTENCE error: never send it.
  assert.equal(url.searchParams.has('deletable'), false);
  assert.equal(url.searchParams.has('send_object_to'), false);
});

test('the epochs and the Blob owner come from the environment', () => {
  const url = new URL(walrusStoreUrl('https://publisher.example', { WALRUS_STORE_EPOCHS: '26', WALRUS_BLOB_OWNER: OWNER }));
  assert.equal(url.searchParams.get('epochs'), '26');
  assert.equal(url.searchParams.get('permanent'), 'true');
  assert.equal(url.searchParams.get('send_object_to'), OWNER);
});

test('an epoch count Walrus would refuse is refused before anything is sent', () => {
  for (const bad of ['0', '54', '1.5', 'max', '-3']) {
    assert.throws(() => walrusStoreEpochs({ WALRUS_STORE_EPOCHS: bad }), /WALRUS_STORE_EPOCHS/);
  }
  assert.equal(walrusStoreEpochs({ WALRUS_STORE_EPOCHS: ' 53 ' }), 53);
  assert.equal(walrusStoreEpochs({ WALRUS_STORE_EPOCHS: '' }), WALRUS_MAX_EPOCHS);
});

test('a Blob owner that is not a Sui address is refused rather than sent to the publisher', () => {
  for (const bad of ['0xabc', 'splash', `${OWNER}00`]) {
    assert.throws(() => walrusStoreUrl('https://publisher.example', { WALRUS_BLOB_OWNER: bad }), /WALRUS_BLOB_OWNER/);
  }
});

/* ── A live store ────────────────────────────────────────────────────── */

const ENV_KEYS = ['USE_MOCK_APIS', 'WALRUS_PUBLISHER_URL', 'WALRUS_AGGREGATOR_URL', 'WALRUS_STORE_EPOCHS', 'WALRUS_BLOB_OWNER'];
let savedEnv;
let savedFetch;
let requests;
let warnings;
let savedWarn;
let errors;
let savedError;

function respondWith(body, status = 200) {
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = globalThis.fetch;
  requests = [];
  warnings = [];
  savedWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  errors = [];
  savedError = console.error;
  console.error = (...args) => errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
  console.warn = savedWarn;
  console.error = savedError;
});

function goLive() {
  process.env.WALRUS_PUBLISHER_URL = 'https://publisher.example';
  process.env.WALRUS_AGGREGATOR_URL = 'https://aggregator.example';
}

const newlyCreated = ({ start = 100, end = 153, deletable = false } = {}) => ({
  newlyCreated: {
    blobObject: {
      id: `0x${'11'.repeat(32)}`,
      registeredEpoch: start,
      blobId: 'NewBlobId123',
      size: 24,
      encodingType: 'RS2',
      certifiedEpoch: start,
      storage: { id: `0x${'22'.repeat(32)}`, startEpoch: start, endEpoch: end, storageSize: 66034000 },
      deletable,
    },
    resourceOperation: { registerFromScratch: { encodedLength: 66034000, epochsAhead: end - start } },
    cost: 132300,
  },
});

test('a live store sends the retention parameters and records the end epoch Walrus reports', async () => {
  goLive();
  process.env.WALRUS_BLOB_OWNER = OWNER;
  respondWith(newlyCreated());

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  const sent = new URL(requests[0].url);
  assert.equal(sent.origin + sent.pathname, 'https://publisher.example/v1/blobs');
  assert.equal(sent.searchParams.get('epochs'), '53');
  assert.equal(sent.searchParams.get('permanent'), 'true');
  assert.equal(sent.searchParams.get('send_object_to'), OWNER);

  assert.equal(blob.mode, 'live');
  assert.equal(blob.blobId, 'NewBlobId123');
  assert.equal(blob.epochs, 53);
  assert.equal(blob.endEpoch, 153);
  assert.equal(blob.deletable, false);
  assert.equal(blob.publisherOutcome, 'newlyCreated');
  assert.deepEqual(warnings, []);
});

test('a new blob Walrus holds for fewer epochs than asked, or as deletable, is recorded and flagged', async () => {
  goLive();
  respondWith(newlyCreated({ start: 100, end: 101, deletable: true }));

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(blob.endEpoch, 101);
  assert.equal(blob.deletable, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NewBlobId123/);
  assert.match(warnings[0], /deletable/);
  assert.match(warnings[0], /1 epoch/);
});

// The publisher may reuse a storage resource bought earlier (the response's
// resourceOperation is then reuseStorage, not registerFromScratch). Its
// storage.startEpoch is when THAT resource began, not when this blob was
// stored, so endEpoch - startEpoch can look like 60 epochs while only 10 are
// left. The latest epoch the response itself names for this blob (it was
// registered and certified then, so the network was at least there) is the
// honest floor to measure from.
test('a blob on reused storage is measured from when it was stored, not from when the storage began', async () => {
  goLive();
  respondWith({
    newlyCreated: {
      blobObject: {
        id: `0x${'11'.repeat(32)}`,
        registeredEpoch: 140,
        blobId: 'ReusedBlob789',
        size: 24,
        encodingType: 'RS2',
        certifiedEpoch: 140,
        storage: { id: `0x${'22'.repeat(32)}`, startEpoch: 90, endEpoch: 150, storageSize: 66034000 },
        deletable: false,
      },
      resourceOperation: { reuseStorage: { encodedLength: 66034000 } },
      cost: 0,
    },
  });

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(blob.endEpoch, 150);
  assert.equal(warnings.length, 1, 'ten epochs left is short of the 53 asked for');
  assert.match(warnings[0], /ReusedBlob789/);
  assert.match(warnings[0], /\b10 epochs\b/);
  assert.match(warnings[0], /epoch 140/, 'says which epoch it measured from');
  assert.doesNotMatch(warnings[0], /\b60 epochs\b/);
});

test('a blob whose response names no epoch to measure from is not called short or long', async () => {
  goLive();
  respondWith({ newlyCreated: { blobObject: { blobId: 'NoStartBlob', storage: { endEpoch: 150 }, deletable: false } } });

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(blob.endEpoch, 150);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NoStartBlob/);
  assert.match(warnings[0], /epoch 150/);
  assert.match(warnings[0], /cannot tell|could not be measured|not measured/);
});

test('an already-certified blob keeps the end epoch Walrus reports, and is flagged as held elsewhere', async () => {
  goLive();
  process.env.WALRUS_BLOB_OWNER = OWNER;
  respondWith({ alreadyCertified: { blobId: 'OldBlobId456', event: { txDigest: 'Digest1', eventSeq: '0' }, endEpoch: 140 } });

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(blob.blobId, 'OldBlobId456');
  assert.equal(blob.epochs, 53);
  assert.equal(blob.endEpoch, 140);
  assert.equal(blob.deletable, null);
  assert.equal(blob.publisherOutcome, 'alreadyCertified');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OldBlobId456/);
  assert.match(warnings[0], /already certified/);
  assert.match(warnings[0], /140/);
});

test('a publisher that reports no end epoch is recorded as unknown and flagged', async () => {
  goLive();
  respondWith({ newlyCreated: { blobObject: { blobId: 'NoEpochBlob' } } });

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(blob.endEpoch, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NoEpochBlob/);
  assert.match(warnings[0], /end epoch/);
});

test('a bad WALRUS_STORE_EPOCHS stops a live store before the publisher is called', async () => {
  goLive();
  process.env.WALRUS_STORE_EPOCHS = '60';
  respondWith(newlyCreated());

  await assert.rejects(storeEncryptedInvoice(CIPHERTEXT), /WALRUS_STORE_EPOCHS/);
  assert.equal(requests.length, 0);
});

/* ── Configuration errors stay on the server ─────────────────────────── */

// A bad WALRUS_STORE_EPOCHS, WALRUS_BLOB_OWNER or a missing aggregator URL is
// the operator's mistake. The detail (which key, what it must be) belongs in
// the server log; the customer whose invoice failed is told storage is not
// available, not the name of an environment variable.
const CONFIG_KEY = /WALRUS_|epoch|Sui address|0x|hex/i;

test('a bad store setting is logged by name on the server and answered generically', async () => {
  for (const [key, value] of [['WALRUS_STORE_EPOCHS', '60'], ['WALRUS_BLOB_OWNER', '0xabc']]) {
    goLive();
    process.env[key] = value;
    respondWith(newlyCreated());
    errors.length = 0;

    const error = await storeEncryptedInvoice(CIPHERTEXT).then(() => null, (e) => e);

    assert.ok(error instanceof walrus.WalrusAdapterError, `${key}: a WalrusAdapterError`);
    assert.equal(requests.length, 0, `${key}: nothing sent`);
    const reply = walrus.walrusErrorReply(error, 'invoice create');
    assert.equal(reply.status, 500, key);
    assert.doesNotMatch(reply.error, CONFIG_KEY, `${key}: the customer is not told the key`);
    assert.ok(reply.error.length > 0, key);
    assert.equal(errors.length, 1, `${key}: one server log line`);
    assert.match(errors[0], new RegExp(key), `${key}: the server log names the key`);
    assert.match(errors[0], /invoice create/, `${key}: and where it happened`);
    delete process.env[key];
  }
});

test('a missing aggregator URL is logged by name on the server and answered generically', async () => {
  process.env.WALRUS_PUBLISHER_URL = 'https://publisher.example';
  respondWith(CIPHERTEXT);

  const error = await retrieveBlob('SomeLiveBlob').then(() => null, (e) => e);

  assert.ok(error instanceof walrus.WalrusAdapterError);
  assert.equal(requests.length, 0);
  const reply = walrus.walrusErrorReply(error, 'walrus proof');
  assert.doesNotMatch(reply.error, CONFIG_KEY);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /WALRUS_AGGREGATOR_URL/);
});

test('the routes that answer a customer use the generic reply, never the raw adapter message', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['app/api/invoices/route.ts', 'app/api/walrus/[blobId]/route.ts']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /walrusErrorReply\(/, `${file} answers through walrusErrorReply`);
    assert.doesNotMatch(text, /error:\s*error\.message/, `${file} must not echo the adapter's message`);
  }
});

/* ── Honest values where nothing was bought or nothing is known ───────── */

test('a demo store buys no Walrus storage and says so', async () => {
  process.env.USE_MOCK_APIS = 'true';
  respondWith(newlyCreated());

  const blob = await storeEncryptedInvoice(CIPHERTEXT);

  assert.equal(requests.length, 0);
  assert.equal(blob.mode, 'demo');
  assert.equal(blob.epochs, 0);
  assert.equal(blob.endEpoch, null);
});

test('a live read does not invent a retention the aggregator never reported', async () => {
  goLive();
  respondWith(CIPHERTEXT);

  const blob = await retrieveBlob('SomeLiveBlob');

  assert.equal(requests[0].url, 'https://aggregator.example/v1/blobs/SomeLiveBlob');
  assert.equal(blob.encryptedData, CIPHERTEXT);
  assert.equal(blob.epochs, null);
  assert.equal(blob.endEpoch, null);
});
