import { describe, it, expect } from 'vitest';
import { BaseUSDCRail } from './base.js';
import { CoinbaseFacilitator } from './coinbase.js';

describe('Rails', () => {
  it('should initialize BaseUSDCRail', () => {
    const rail = new BaseUSDCRail('sepolia');
    expect(rail.id).toBe('base:usdc');
  });

  it('should initialize CoinbaseFacilitator', () => {
    const facilitator = new CoinbaseFacilitator('key', 'secret');
    expect(facilitator.id).toBe('coinbase');
  });
});
