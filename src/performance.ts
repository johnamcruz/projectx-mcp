export interface Trade {
  id: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null;
  fees: number | null;
  side: number;
  size: number;
  voided: boolean;
  orderId: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function stats(trades: Trade[]) {
  const live = trades.filter((t) => !t.voided);
  // A null profitAndLoss marks the opening half of a round turn.
  const closes = live.filter((t) => t.profitAndLoss !== null);
  const pnls = closes.map((t) => t.profitAndLoss as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const gross = pnls.reduce((a, b) => a + b, 0);
  const fees = live.reduce((a, t) => a + (t.fees ?? 0), 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    fills: live.length,
    closingFills: closes.length,
    wins: wins.length,
    losses: losses.length,
    scratches: pnls.length - wins.length - losses.length,
    winRate: closes.length ? round(wins.length / closes.length) : null,
    grossPnL: round(gross),
    fees: round(fees),
    netPnL: round(gross - fees),
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    largestWin: wins.length ? round(Math.max(...wins)) : null,
    largestLoss: losses.length ? round(Math.min(...losses)) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    expectancyPerClose: closes.length ? round((gross - fees) / closes.length) : null,
  };
}

/** Aggregate performance statistics from Trade/search results. */
export function summarizeTrades(trades: Trade[]) {
  const byContract: Record<string, ReturnType<typeof stats>> = {};
  for (const id of new Set(trades.map((t) => t.contractId))) {
    byContract[id] = stats(trades.filter((t) => t.contractId === id));
  }
  return { overall: stats(trades), byContract };
}
