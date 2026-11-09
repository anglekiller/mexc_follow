import type { PendingOrder, Position } from './types';

/**
 * The TP/SL orders protecting a position: matched by position id when the exchange reports it
 * (MEXC), otherwise by symbol and closing side (4 closes a long, 2 closes a short).
 */
export function tpslOf(p: Position, orders: PendingOrder[]) {
  const closeSide = p.positionType === 1 ? 4 : 2;
  const mine = orders.filter(
    (o) =>
      o.kind === 'tpsl' &&
      o.symbol === p.symbol &&
      (o.positionId ? o.positionId === p.positionId : o.side === undefined || o.side === closeSide),
  );
  return {
    orders: mine,
    tp: mine.find((o) => o.takeProfitPrice)?.takeProfitPrice,
    sl: mine.find((o) => o.stopLossPrice)?.stopLossPrice,
  };
}
