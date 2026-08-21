import { Client } from 'xrpl';
import { RailLookupError } from './interface.js';

/**
 * How the XRPL rail talks to a node. Two transports exist for one reason: independent
 * verification is the security critical path, and plenty of the environments that most need
 * governance only allow outbound HTTPS. Forcing a websocket there would leave the seller with
 * either no independent check or a hole in its egress policy, and both are worse than a slightly
 * chattier transport.
 */
export interface XrplTransport {
  request(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface WebSocketTransportOptions {
  wssUrl: string;
  client?: Client;
  connectionTimeoutMs?: number;
}

/** Websocket transport, the xrpl.js default. Preferred when egress allows it. */
export class XrplWebSocketTransport implements XrplTransport {
  private readonly client: Client;
  private readonly ownsClient: boolean;

  constructor(options: WebSocketTransportOptions) {
    if (options.client === undefined) {
      this.client = new Client(options.wssUrl, {
        connectionTimeout: options.connectionTimeoutMs ?? 10_000,
      });
      this.ownsClient = true;
    } else {
      this.client = options.client;
      this.ownsClient = false;
    }
  }

  async request(
    command: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.client.isConnected()) {
      try {
        await this.client.connect();
      } catch (error) {
        throw new RailLookupError(
          `could not connect to the XRPL node: ${error instanceof Error ? error.message : String(error)}`,
          String(params.transaction ?? ''),
        );
      }
    }
    const response = (await this.client.request({
      command,
      ...params,
    } as Parameters<Client['request']>[0])) as { result: Record<string, unknown> };
    return response.result;
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.isConnected()) {
      await this.client.disconnect();
    }
  }
}

export interface JsonRpcTransportOptions {
  /** An https JSON-RPC endpoint, for example https://testnet.xrpl-labs.com/ */
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcBody {
  result?: Record<string, unknown> & { error?: string; error_message?: string; status?: string };
}

/**
 * JSON-RPC over HTTPS. rippled reports an application level failure inside a 200 response, so a
 * successful HTTP status proves nothing here and the body has to be inspected.
 */
export class XrplJsonRpcTransport implements XrplTransport {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JsonRpcTransportOptions) {
    const url = new URL(options.rpcUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(
        `XRPL JSON-RPC endpoint must use https, or http on a loopback host: ${options.rpcUrl}`,
      );
    }
    this.rpcUrl = options.rpcUrl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(
    command: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: command, params: [params] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new RailLookupError(
          `XRPL JSON-RPC endpoint returned ${response.status}`,
          String(params.transaction ?? ''),
        );
      }
      const body = (await response.json()) as JsonRpcBody;
      const result = body.result;
      if (result === undefined) {
        throw new RailLookupError(
          'XRPL JSON-RPC response carried no result',
          String(params.transaction ?? ''),
        );
      }
      if (typeof result.error === 'string') {
        throw new RailLookupError(
          `XRPL node reported ${result.error}${result.error_message === undefined ? '' : `: ${result.error_message}`}`,
          String(params.transaction ?? ''),
        );
      }
      return result;
    } catch (error) {
      if (error instanceof RailLookupError) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new RailLookupError(
        aborted
          ? `XRPL JSON-RPC endpoint did not respond within ${this.timeoutMs} ms`
          : `could not reach the XRPL JSON-RPC endpoint: ${error instanceof Error ? error.message : String(error)}`,
        String(params.transaction ?? ''),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Stateless over HTTP; nothing to release.
  }
}
