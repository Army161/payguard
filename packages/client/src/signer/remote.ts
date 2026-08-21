import {
  PaymentPayloadSchema,
  type PaymentPayload,
  type PaymentRequirements,
} from '@payguard/core';
import { SignerError, type Signer } from './interface.js';

export interface RemoteSignerOptions {
  /** The address this signer pays from. */
  address: string;
  /**
   * Performs the signing. Whatever is behind this never returns key material, only a payload.
   * A KMS client, an HSM session, an MPC wallet SDK, or a TEE enclave all fit here unchanged.
   */
  sign(requirements: PaymentRequirements): Promise<unknown>;
  /** Human readable name for the backend, used in audit entries and error messages. */
  backend: string;
}

/**
 * The adapter every production signer uses: KMS, HSM, MPC, or TEE. PayGuard never learns what is
 * behind it, which is the point.
 *
 * The returned payload is schema validated before use. A signing backend is trusted with the key,
 * not with the protocol, and a malformed payload from a wallet SDK should fail here rather than at
 * the seller with a confusing 402.
 */
export class RemoteSigner implements Signer {
  constructor(private readonly options: RemoteSignerOptions) {}

  get backend(): string {
    return this.options.backend;
  }

  async address(): Promise<string> {
    return this.options.address;
  }

  async signPayment(requirements: PaymentRequirements): Promise<PaymentPayload> {
    const raw = await this.options.sign(requirements);
    const parsed = PaymentPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SignerError(
        `${this.options.backend} returned something that is not a valid x402 payment payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    if (parsed.data.network !== requirements.network) {
      throw new SignerError(
        `${this.options.backend} signed for network ${parsed.data.network} but the seller requires ${requirements.network}`,
      );
    }
    return parsed.data;
  }
}

/**
 * A KMS or HSM backed signer. The key never leaves the module, and this process only ever sees
 * the finished payload.
 */
export function kmsSigner(options: Omit<RemoteSignerOptions, 'backend'>): RemoteSigner {
  return new RemoteSigner({ ...options, backend: 'kms' });
}

/**
 * An agentic wallet signer: Coinbase Agentic Wallets, Turnkey, Privy, or any other MPC or TEE
 * custodian of the buyer's key. Identical mechanics to the KMS signer; the name is what shows up
 * in the audit trail.
 */
export function agenticWalletSigner(
  options: Omit<RemoteSignerOptions, 'backend'> & { provider: string },
): RemoteSigner {
  return new RemoteSigner({ ...options, backend: `agentic-wallet:${options.provider}` });
}
