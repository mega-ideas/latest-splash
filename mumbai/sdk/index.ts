/**
 * The Splash checkout SDK for Whitechain.
 *
 * A merchant raises an invoice; a customer pays it by signing, never by sending
 * a transaction. The customer needs no WBT.
 *
 *   const splash = new SplashCheckout({ chain, invoiceContract, usdt });
 *   await splash.createInvoice({ invoiceId, amount, dueAt, commitment });
 *   const auth = await splash.authorizePayment({ invoiceId, amount, customer });
 *   await splash.relay(auth);            // the relayer pays the gas
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, type Address, type Hex,
  type WalletClient, type PublicClient, type Chain,
} from 'viem';

export const INVOICE_ABI = parseAbi([
  'function createInvoice(bytes32 invoiceId, uint256 amount, uint64 dueAt, bytes32 travelRuleCommitment)',
  'function payWithAuthorization(bytes32 invoiceId, address from, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function recordProof(bytes32 invoiceId, bytes32 travelRuleCommitment)',
  'function forfeitFee(bytes32 invoiceId)',
  'function getInvoice(bytes32 invoiceId) view returns ((address merchant,uint256 amount,uint256 feeAmount,uint64 dueAt,uint64 proofDeadline,bytes32 travelRuleCommitment,uint8 status,address payer))',
  'event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, uint256 netToMerchant, uint256 feeHeld)',
  'event ProofRecorded(bytes32 indexed invoiceId, bytes32 travelRuleCommitment, uint256 feeToSplash)',
  'event FeeForfeited(bytes32 indexed invoiceId, address indexed merchant, uint256 feeAmount)',
]);

/** The official Whitechain USDT. The bridged USDT.e is a different token. */
export const WHITECHAIN_USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';

export type SplashCheckoutOptions = {
  chain: Chain;
  rpcUrl: string;
  invoiceContract: Address;
  usdt?: Address;
};

/** A signed authorisation. It names the invoice contract, so a relayer cannot redirect it. */
export type PaymentAuthorization = {
  invoiceId: Hex;
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
};

export const invoiceId = (reference: string): Hex => keccak256(toHex(reference));

export class SplashCheckout {
  readonly publicClient: PublicClient;
  readonly invoiceContract: Address;
  readonly usdt: Address;
  private readonly chain: Chain;

  constructor(opts: SplashCheckoutOptions) {
    this.chain = opts.chain;
    this.invoiceContract = opts.invoiceContract;
    this.usdt = opts.usdt ?? WHITECHAIN_USDT;
    this.publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  }

  /** The merchant raises the invoice. The fee is fixed here and cannot grow. */
  async createInvoice(
    wallet: WalletClient,
    args: { reference: string; amount: bigint; dueAt: bigint; travelRuleCommitment: Hex },
  ) {
    return wallet.writeContract({
      address: this.invoiceContract,
      abi: INVOICE_ABI,
      functionName: 'createInvoice',
      args: [invoiceId(args.reference), args.amount, args.dueAt, args.travelRuleCommitment],
      chain: this.chain,
      account: wallet.account!,
    });
  }

  /**
   * The customer signs an EIP-3009 authorisation. No transaction, no gas token.
   * `to` is the invoice contract, so the signature cannot be redirected, and the
   * random nonce makes it single-use.
   */
  async authorizePayment(
    wallet: WalletClient,
    args: { reference: string; amount: bigint; validForSeconds?: bigint },
  ): Promise<PaymentAuthorization> {
    const from = wallet.account!.address;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = 0n;
    const validBefore = now + (args.validForSeconds ?? 3600n);
    const nonce = keccak256(toHex(`${args.reference}:${from}:${now}:${Math.random()}`));

    const signature = await wallet.signTypedData({
      account: wallet.account!,
      domain: {
        name: 'Tether USD',
        version: '1',
        chainId: this.chain.id,
        verifyingContract: this.usdt,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from,
        to: this.invoiceContract,
        value: args.amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    const v = Number.parseInt(signature.slice(130, 132), 16);

    return { invoiceId: invoiceId(args.reference), from, value: args.amount, validAfter, validBefore, nonce, v, r, s };
  }

  /** Anyone may relay it. The relayer pays the gas; the signature decides who pays the invoice. */
  async relay(relayer: WalletClient, auth: PaymentAuthorization) {
    return relayer.writeContract({
      address: this.invoiceContract,
      abi: INVOICE_ABI,
      functionName: 'payWithAuthorization',
      args: [auth.invoiceId, auth.from, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s],
      chain: this.chain,
      account: relayer.account!,
    });
  }

  async getInvoice(reference: string) {
    return this.publicClient.readContract({
      address: this.invoiceContract,
      abi: INVOICE_ABI,
      functionName: 'getInvoice',
      args: [invoiceId(reference)],
    });
  }

  /** Splash records the proof. The only path that pays Splash. */
  async recordProof(attestor: WalletClient, reference: string, travelRuleCommitment: Hex) {
    return attestor.writeContract({
      address: this.invoiceContract,
      abi: INVOICE_ABI,
      functionName: 'recordProof',
      args: [invoiceId(reference), travelRuleCommitment],
      chain: this.chain,
      account: attestor.account!,
    });
  }
}

export { createWalletClient, http };
