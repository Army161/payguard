import { PayGuardOptions } from './express.js';
// Simplified adapters for Hono and Fastify

export function payguardHono(options: PayGuardOptions) {
  // Implementation would be similar to express but using Hono Context
  return async (c: any, next: any) => {
    // ... logic ...
    await next();
  };
}

export function payguardFastify(options: PayGuardOptions) {
  return async (request: any, reply: any) => {
    // ... logic ...
  };
}
