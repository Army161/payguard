import {
  X402_VERSION,
  isMainnet,
  type PaymentPayload,
  type PaymentRequirements,
} from '@payguard/core';
import { SignerError, type Signer } from './interface.js';

export interface RawKeySignerOptions {
  /**
   * A signing callback the caller supplies. PayGuard deliberately does not accept a private key
   * here: taking one would put key material inside a PayGuard object, and every later refactor
   * would have to keep proving it never leaked. The caller keeps the key in its own closure.
   */
  sign(digest: string, requirements: PaymentRequirements): Promise<string>;
  /** The address the callback signs for. */
  address: string;
  /** Overridden in tests only. Defaults to reading NODE_ENV. */
  env?: NodeJS.ProcessEnv;
  /** Emits the development warning. Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Nonce source. Defaults to a random 32 byte value. */
  nonce?: () => string;
  /** Current time in epoch seconds. Defaults to the wall clock. */
  nowSeconds?: () => number;
}

/**
 * Development signer for the `exact` EVM scheme.
 *
 * It refuses to run under NODE_ENV=production and refuses any mainnet network outright, because a
 * signer whose key lives in the same process as the agent is a development convenience and
 * nothing more. spec.md FR-3.2 calls it dev only; this makes that a runtime fact rather than a
 * comment nobody reads.
 */
export class RawKeySigner implements Signer {
  private readonly options: RawKeySignerOptions;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: RawKeySignerOptions) {
    this.options = options;
    this.env = options.env ?? process.env;

    if (this.env.NODE_ENV === 'production') {
      throw new SignerError(
        'RawKeySigner is disabled when NODE_ENV=production; use a KMS, HSM, MPC, or TEE backed signer instead',
      );
    }

    const warn = options.warn ?? ((message: string) => console.warn(message));
    warn(
      'PayGuard: RawKeySigner is in use. It is for development only. Any key reachable from this process is reachable by anything else in this process.',
    );
  }

  async address(): Promise<string> {
    return this.options.address;
  }

  async signPayment(requirements: PaymentRequirements): Promise<PaymentPayload> {
    if (isMainnet(requirements.network)) {
      throw new SignerError(
        `RawKeySigner refuses to sign on the mainnet network ${requirements.network}`,
      );
    }
    if (requirements.scheme !== 'exact') {
      throw new SignerError(
        `RawKeySigner only implements the exact scheme, not ${requirements.scheme}`,
      );
    }

    const now = this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.options.address,
      to: requirements.payTo,
      value: requirements.maxAmountRequired,
      validAfter: String(now - 60),
      validBefore: String(now + requirements.maxTimeoutSeconds),
      nonce: this.options.nonce?.() ?? randomNonce(),
    };

    const signature = await this.options.sign(
      JSON.stringify({ authorization, network: requirements.network }),
      requirements,
    );

    return {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: requirements.network,
      payload: { signature, authorization },
    };
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}
