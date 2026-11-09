import type { ContractInfo, Position } from './types';

/** Unrealized PnL (USDT) and ROE (%) of a USDT-M position at `mark`. */
export function positionPnl(p: Position, mark: number, contract: ContractInfo) {
  const dir = p.positionType === 1 ? 1 : -1;
  const pnl = (mark - p.holdAvgPrice) * p.holdVol * contract.contractSize * dir;
  const roe = p.im > 0 ? (pnl / p.im) * 100 : undefined;
  return { pnl, roe };
}
