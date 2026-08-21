import { Client } from 'xrpl';
import { Rail } from './interfaces.js';
import { VerifyResult } from '@payguard/core';

export class XRPLRail implements Rail {
  id: string;
  private client: Client;

  constructor(id: 'xrpl:rlusd' | 'xrpl:xrp', server: string) {
    this.id = id;
    this.client = new Client(server);
  }

  async verifyOnChain(txHash: string, expect: {
    to: string;
    asset: string;
    amount: string;
    network: string;
  }): Promise<VerifyResult> {
    try {
      if (!this.client.isConnected()) await this.client.connect();
      
      const response = await this.client.request({
        command: 'tx',
        transaction: txHash,
      });

      const tx = response.result;
      if (!tx.validated) {
        return { valid: false, reason: 'TRANSACTION_NOT_VALIDATED' };
      }

      // Check transaction type and destination
      if (tx.TransactionType !== 'Payment' || tx.Destination !== expect.to) {
        return { valid: false, reason: 'INVALID_TRANSACTION_DETAILS' };
      }

      // TODO: Verify amount and asset (RLUSD vs XRP)
      
      return { valid: true, txHash };
    } catch (e: any) {
      return { valid: false, reason: e.message };
    } finally {
      // Keep connection open or close? Usually better to keep for reuse
    }
  }
}
