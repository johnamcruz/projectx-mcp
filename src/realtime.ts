import { HubConnection, HubConnectionBuilder, HubConnectionState, HttpTransportType, LogLevel } from "@microsoft/signalr";

export interface Quote {
  symbol?: string;
  lastPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  lastUpdated?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/** The subset of a SignalR HubConnection this module uses (lets tests inject a fake). */
export type HubConnectionLike = Pick<HubConnection, "on" | "onreconnecting" | "onreconnected" | "onclose" | "start" | "stop" | "invoke" | "state">;

export function buildSignalRConnection(url: string, getToken: () => Promise<string>): HubConnectionLike {
  return new HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      accessTokenFactory: () => getToken(),
      timeout: 10000,
    })
    .withAutomaticReconnect()
    // stdout is the MCP stdio channel; never let SignalR log there.
    .configureLogging(LogLevel.None)
    .build();
}

export interface QuoteSource {
  getQuote(contractId: string, timeoutMs?: number): Promise<{ quote: Quote; ageMs: number } | null>;
  close(): Promise<void>;
}

/** Market hub feeds per contract. */
export type FeedKind = "quotes" | "trades" | "depth";

export const SUBSCRIBE_METHOD: Readonly<Record<FeedKind, string>> = {
  quotes: "SubscribeContractQuotes",
  trades: "SubscribeContractTrades",
  depth: "SubscribeContractMarketDepth",
};

export const UNSUBSCRIBE_METHOD: Readonly<Record<FeedKind, string>> = {
  quotes: "UnsubscribeContractQuotes",
  trades: "UnsubscribeContractTrades",
  depth: "UnsubscribeContractMarketDepth",
};

/** Callbacks for hub events. Each runs isolated: a throw is caught and never reaches SignalR. */
export interface HubListener {
  quote?(contractId: string, data: Quote): void;
  trade?(contractId: string, data: unknown): void;
  depth?(contractId: string, data: unknown): void;
  /** The hub confirmed a subscription (the first time, or again after a reconnect). */
  subscribed?(kind: FeedKind, contractId: string): void;
  /** The connection dropped (reconnecting or closed): every subscription is down until `subscribed` fires again. */
  down?(): void;
}

/** What the order-flow feed needs from the hub (lets tests inject a fake). */
export interface FlowHub {
  addListener(l: HubListener): () => void;
  subscribe(kind: FeedKind, contractId: string): Promise<void>;
  unsubscribe(kind: FeedKind, contractId: string): Promise<void>;
}

const subKey = (kind: FeedKind, id: string) => `${kind}|${id}`;

/**
 * Lazily-connected SignalR market hub client: one connection for quotes,
 * trades and depth. Keeps a merged latest-quote cache, passes trade and depth
 * pushes to listeners, and restores every subscription after a reconnect.
 */
export class MarketHub implements QuoteSource, FlowHub {
  private conn: HubConnectionLike | null = null;
  private starting: Promise<HubConnectionLike> | null = null;
  private readonly quotes = new Map<string, { quote: Quote; receivedAt: number }>();
  /** Subscriptions to restore after a reconnect. */
  private readonly subscribed = new Map<string, [FeedKind, string]>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly listeners = new Set<HubListener>();
  /** Every connection built, so close() stops them all. */
  private readonly built = new Set<HubConnectionLike>();

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
    private readonly build: (url: string, getToken: () => Promise<string>) => HubConnectionLike = buildSignalRConnection,
  ) {}

  addListener(l: HubListener): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  private emit(fn: (l: HubListener) => void): void {
    for (const l of this.listeners) {
      try {
        fn(l);
      } catch {
        // A listener bug must never break the hub connection or the other listeners.
      }
    }
  }

  /**
   * The current connection, or a new one. While the current connection is
   * connecting or reconnecting this fails fast instead of building a second
   * one (two live connections would deliver every print twice); a new one is
   * built only once the old one has closed.
   */
  private connect(): Promise<HubConnectionLike> {
    const cur = this.conn;
    if (cur?.state === HubConnectionState.Connected) return Promise.resolve(cur);
    if (cur && (cur.state === HubConnectionState.Connecting || cur.state === HubConnectionState.Reconnecting)) {
      return Promise.reject(new Error("The market hub connection is reconnecting; try again shortly."));
    }
    this.starting ??= (async () => {
      try {
        const conn = this.build(this.url, this.getToken);
        this.built.add(conn);
        conn.on("GatewayQuote", (contractId: string, data: Quote) => {
          if (typeof contractId !== "string" || typeof data !== "object" || data === null) return;
          const prev = this.quotes.get(contractId)?.quote ?? {};
          // Quote pushes can be partial; merge onto the last known state.
          this.quotes.set(contractId, { quote: { ...prev, ...data }, receivedAt: Date.now() });
          for (const w of this.waiters.get(contractId) ?? []) w();
          this.waiters.delete(contractId);
          this.emit((l) => l.quote?.(contractId, data));
        });
        conn.on("GatewayTrade", (contractId: string, data: unknown) => {
          if (typeof contractId === "string") this.emit((l) => l.trade?.(contractId, data));
        });
        conn.on("GatewayDepth", (contractId: string, data: unknown) => {
          if (typeof contractId === "string") this.emit((l) => l.depth?.(contractId, data));
        });
        conn.onreconnecting(() => {
          if (this.conn === conn) this.emit((l) => l.down?.());
        });
        conn.onreconnected(async () => {
          if (this.conn !== conn) return;
          for (const [kind, id] of [...this.subscribed.values()]) {
            try {
              await conn.invoke(SUBSCRIBE_METHOD[kind], id);
              this.emit((l) => l.subscribed?.(kind, id));
            } catch {
              // Left down: the order-flow feed retries missing subscriptions on its timer.
            }
          }
        });
        conn.onclose(() => {
          this.built.delete(conn);
          // A late close of an older connection must never touch a newer one's state.
          if (this.conn !== conn) return;
          this.conn = null;
          this.subscribed.clear();
          this.emit((l) => l.down?.());
        });
        try {
          await conn.start();
        } catch (e) {
          this.built.delete(conn);
          throw e;
        }
        // The old connection (closed) is replaced only now.
        this.conn = conn;
        return conn;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Subscribe a feed for a contract (connecting first if needed); restored after a reconnect. */
  async subscribe(kind: FeedKind, contractId: string): Promise<void> {
    const conn = await this.connect();
    await conn.invoke(SUBSCRIBE_METHOD[kind], contractId);
    this.subscribed.set(subKey(kind, contractId), [kind, contractId]);
    this.emit((l) => l.subscribed?.(kind, contractId));
  }

  async unsubscribe(kind: FeedKind, contractId: string): Promise<void> {
    if (!this.subscribed.delete(subKey(kind, contractId))) return;
    if (this.conn?.state === HubConnectionState.Connected) await this.conn.invoke(UNSUBSCRIBE_METHOD[kind], contractId);
  }

  /** Latest quote for a contract, waiting up to timeoutMs for the first push. */
  async getQuote(contractId: string, timeoutMs = 5000): Promise<{ quote: Quote; ageMs: number } | null> {
    if (!this.subscribed.has(subKey("quotes", contractId))) await this.subscribe("quotes", contractId);
    if (!this.quotes.has(contractId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const list = this.waiters.get(contractId) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.waiters.set(contractId, list);
      });
    }
    const hit = this.quotes.get(contractId);
    return hit ? { quote: hit.quote, ageMs: Date.now() - hit.receivedAt } : null;
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await Promise.all([...this.built].map((c) => c.stop().catch(() => {})));
    this.built.clear();
  }
}
