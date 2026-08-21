import { AuditEntry } from '@payguard/core';

export interface Store {
  claimNonce(key: string, ttlSeconds: number): Promise<boolean>;
  getIdempotentResponse<T>(key: string): Promise<T | null>;
  setIdempotentResponse<T>(key: string, response: T, ttlSeconds: number): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  getAuditLog(): Promise<AuditEntry[]>;
  close(): Promise<void>;
}
