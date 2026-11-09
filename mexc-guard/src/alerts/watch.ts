import { positionPnl } from '../api/pnl';
import { tpslOf } from '../api/tpsl';
import type { ContractInfo, PendingOrder, Position } from '../api/types';
import type { Exchange } from '../exchanges';
import type { WatchedPosition } from './engine';

/** Builds the rules' view of a position from exchange data. */
export function toWatched(
  api: Exchange,
  p: Position,
  mark: number | undefined,
  contract: ContractInfo | undefined,
  orders: PendingOrder[],
): WatchedPosition | null {
  if (!mark || !contract) return null;
  const { pnl, roe } = positionPnl(p, mark, contract);
  const qty = p.holdVol * contract.contractSize;
  const t = tpslOf(p, orders);
  return {
    id: p.positionId,
    symbol: p.symbol,
    name: api.baseOf(p.symbol),
    long: p.positionType === 1,
    leverage: p.leverage,
    entry: p.holdAvgPrice,
    mark,
    liq: p.liquidatePrice,
    pnl,
    roe: roe ?? 0,
    margin: p.im || (p.leverage > 0 ? (qty * p.holdAvgPrice) / p.leverage : 0),
    tp: t.tp,
    sl: t.sl,
    openTime: p.createTime || Date.now(),
    priceDp: contract.priceScale,
  };
}
