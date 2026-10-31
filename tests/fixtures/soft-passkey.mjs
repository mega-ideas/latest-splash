/**
 * A passkey in software, for tests: a P-256 key in this process standing in
 * for an authenticator, behind the SDK's own PasskeyKeypair. Its signatures
 * are real SIP-9 passkey signatures (authenticator data, client data JSON
 * with the challenge, a DER ECDSA signature), so a 2-of-3 of these combines
 * and verifies exactly as one of hardware passkeys does.
 *
 * What it does NOT prove: that a real authenticator (iCloud Keychain, Google
 * Password Manager, a YubiKey) produces signatures the chain accepts in a
 * multisig. That is the hardware 2-of-3 check owed from Phase 0, which needs
 * people with devices (docs/v2/phase2-business-wallet.md, runbook step).
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { PasskeyKeypair } from '@mysten/sui/keypairs/passkey';

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function compressed(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return new Uint8Array(Buffer.concat([Buffer.from([y[y.length - 1] & 1 ? 0x03 : 0x02]), x]));
}

/** A software passkey: `{ keypair, publicKey (base64, 33 bytes), address }`. */
export function softPasskey(rpId = 'localhost') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = compressed(publicKey);
  const provider = {
    async create() {
      throw new Error('a software passkey is created already');
    },
    async get(challenge) {
      const rpIdHash = createHash('sha256').update(rpId).digest();
      // flags: user present (0x01) and user verified (0x04); counter 0.
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: `https://${rpId}`, crossOrigin: false }));
      const payload = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
      const signature = sign('sha256', payload, privateKey);
      const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { response: { authenticatorData: ab(authenticatorData), clientDataJSON: ab(clientDataJSON), signature: ab(signature) } };
    },
  };
  const keypair = new PasskeyKeypair(point, provider);
  return { keypair, publicKey: Buffer.from(point).toString('base64'), address: keypair.getPublicKey().toSuiAddress() };
}
