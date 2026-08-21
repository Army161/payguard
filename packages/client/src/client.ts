import { 
  PolicyEngine, 
  PolicyConfig, 
  SpendContext, 
  Decision, 
  PaymentRequirements,
  PaymentPayload
} from '@payguard/core';
import { Signer } from './signer.js';
import fs from 'node:fs';

export interface ClientOptions {
  signer: Signer;
  policyConfig: PolicyConfig;
  killSwitchFile?: string;
}

export class PayGuardClient {
  private policyEngine: PolicyEngine;
  private killSwitchFile: string;

  constructor(private options: ClientOptions) {
    this.policyEngine = new PolicyEngine(options.policyConfig);
    this.killSwitchFile = options.killSwitchFile || '.payguard-halt';
  }

  isKilled(): boolean {
    return fs.existsSync(this.killSwitchFile);
  }

  async requestPayment(req: PaymentRequirements, history: { dailyTotal: bigint, hourlyTotal: bigint }): Promise<PaymentPayload> {
    if (this.isKilled()) {
      throw new Error('PAYGUARD_KILLED');
    }

    const ctx: SpendContext = {
      amount: req.amount,
      counterparty: req.recipient,
      rail: req.accepts[0].rail, // Simplified: pick first
      velocity: 1, // Simplified
      caps: {
        daily: this.options.policyConfig.dailyCap.toString(),
        hourly: this.options.policyConfig.hourlyCap.toString(),
      },
    };

    const decision = this.policyEngine.evaluate(ctx, history);

    if (decision.type === 'deny') {
      throw new Error(`POLICY_DENIED: ${decision.reason}`);
    }

    if (decision.type === 'require_human') {
      // In a real scenario, this would trigger a UI prompt
      throw new Error(`HUMAN_APPROVAL_REQUIRED: ${decision.reason}`);
    }

    return this.options.signer.signPayment(req);
  }
}
