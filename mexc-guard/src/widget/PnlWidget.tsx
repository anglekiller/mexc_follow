import { FlexWidget, TextWidget } from 'react-native-android-widget';

import type { Snapshot, WidgetPosition } from './snapshot';

export const WIDGET_NAME = 'Pnl';
export const REFRESH_ACTION = 'REFRESH';
/**
 * Close buttons need two taps: the first arms (CLOSE_ACTION), a second within CLOSE_WINDOW_MS
 * confirms (CLOSE_CONFIRM_ACTION). clickActionData.target is a position key or ALL_TARGET.
 */
export const CLOSE_ACTION = 'CLOSE';
export const CLOSE_CONFIRM_ACTION = 'CLOSE_CONFIRM';
export const CLOSE_WINDOW_MS = 5_000;
export const ALL_TARGET = '*';

/** Stable id of a widget row; the position id when known. */
export const positionKey = (p: WidgetPosition) => p.id ?? `${p.symbol}|${p.long ? 'L' : 'S'}`;

type Hex = `#${string}`;
const C: Record<'bg' | 'text' | 'muted' | 'long' | 'short' | 'border' | 'warn' | 'shortDim', Hex> = {
  bg: '#121212',
  text: '#FFFFFF',
  muted: '#8A8F98',
  long: '#00C087',
  short: '#F6465D',
  border: '#2E2E2E',
  warn: '#F0B90B',
  shortDim: '#3A1A1F',
};

const ROW_HEIGHT = 28;

const pnlColor = (n: number): Hex => (n > 0 ? C.long : n < 0 ? C.short : C.text);

function num(n: number, d = 2) {
  const [int, frac] = Math.abs(n).toFixed(d).split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}
const signed = (n: number, d = 2) => `${n > 0 ? '+' : ''}${num(n, d)}`;

function hhmm(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  snap: Snapshot | null;
  /** Shown instead of the update time, e.g. "Đang cập nhật…" or an error. */
  status?: string;
  /** Widget height in dp, used to decide how many position rows fit. */
  height: number;
  /** Close target waiting for its confirming tap (position key or ALL_TARGET). */
  armed?: string | null;
  /** Close target currently being executed. */
  running?: string | null;
  /** Show the close buttons (setting "Nút đóng lệnh trên widget"). */
  allowClose?: boolean;
}

/** Two-tap close button; `label` is shown while idle. */
function CloseButton({
  target,
  label,
  armedLabel,
  armed,
  running,
  height,
}: {
  target: string;
  label: string;
  armedLabel: string;
  armed?: string | null;
  running?: string | null;
  height: number;
}) {
  const isArmed = armed === target;
  const isRunning = running === target || running === ALL_TARGET;
  const idle = !isArmed && !isRunning;
  return (
    <FlexWidget
      clickAction={isRunning ? undefined : isArmed ? CLOSE_CONFIRM_ACTION : CLOSE_ACTION}
      clickActionData={{ target }}
      style={{
        height,
        paddingHorizontal: 10,
        borderRadius: height / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: idle ? C.shortDim : C.short,
      }}
    >
      <TextWidget
        text={isRunning ? 'Đang đóng…' : isArmed ? armedLabel : label}
        style={{ fontSize: 12, fontWeight: 'bold', color: idle ? C.short : C.text }}
      />
    </FlexWidget>
  );
}

export function PnlWidget({ snap, status, height, armed, running, allowClose = true }: Props) {
  const hasPositions = (snap?.positions.length ?? 0) > 0;
  // Close-all lives in the header row: the reported widget height ignores the system font
  // scale, so anything placed at the bottom can end up clipped.
  const showAll = allowClose && (hasPositions || armed === ALL_TARGET || running === ALL_TARGET);
  const maxRows = Math.max(Math.floor((height - 96 - (showAll ? 8 : 0)) / ROW_HEIGHT), 0);
  const rows = snap?.positions.slice(0, maxRows) ?? [];
  const hidden = (snap?.positions.length ?? 0) - rows.length;

  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: C.bg,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center' }}>
        {/* A long status needs the room when the close-all button is in the header too. */}
        {!(showAll && status) && (
          <TextWidget text={`${snap?.exchange ?? 'MEXC'} Futures`} style={{ fontSize: 12, color: C.muted, fontWeight: '600' }} />
        )}
        <FlexWidget style={{ flex: 1 }} />
        {showAll && (
          <CloseButton
            target={ALL_TARGET}
            label="⛔ Đóng hết"
            armedLabel="Đóng HẾT?"
            armed={armed}
            running={running}
            height={26}
          />
        )}
        <TextWidget
          text={`${status ?? (snap ? hhmm(snap.time) : '—')}  ⟳`}
          clickAction={REFRESH_ACTION}
          style={{ fontSize: 12, color: status ? C.warn : C.muted, paddingLeft: 10, paddingVertical: 2 }}
        />
      </FlexWidget>

      {/* Total */}
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'flex-end', marginTop: 4 }}>
        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text="Tổng PnL (USDT)" style={{ fontSize: 11, color: C.muted }} />
          <TextWidget
            text={snap ? signed(snap.unrealized) : '—'}
            style={{ fontSize: 24, fontWeight: 'bold', color: pnlColor(snap?.unrealized ?? 0) }}
          />
        </FlexWidget>
        <FlexWidget style={{ flex: 1 }} />
        <FlexWidget style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
          <TextWidget text="Equity" style={{ fontSize: 11, color: C.muted }} />
          <TextWidget text={snap ? num(snap.equity) : '—'} style={{ fontSize: 15, color: C.text, fontWeight: '600' }} />
        </FlexWidget>
      </FlexWidget>

      {maxRows > 0 && (
        <FlexWidget style={{ width: 'match_parent', height: 1, backgroundColor: C.border, marginVertical: 6 }} />
      )}

      {/* Positions, each with its own two-tap close button */}
      {rows.map((p) => {
        const key = positionKey(p);
        return (
          <FlexWidget
            key={key}
            style={{ width: 'match_parent', height: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center' }}
          >
            <TextWidget text={p.name ?? p.symbol.replace(/[_-]?USDT$/, '')} style={{ fontSize: 13, color: C.text, fontWeight: '700' }} />
            <TextWidget
              text={`  ${p.long ? 'Long' : 'Short'} ${p.leverage}x`}
              style={{ fontSize: 11, color: p.long ? C.long : C.short, fontWeight: '600' }}
            />
            <FlexWidget style={{ flex: 1 }} />
            <TextWidget text={signed(p.pnl)} style={{ fontSize: 13, color: pnlColor(p.pnl), fontWeight: '700' }} />
            {p.roe !== undefined && (
              <TextWidget text={`  ${signed(p.roe, 1)}%`} style={{ fontSize: 11, color: pnlColor(p.roe) }} />
            )}
            {allowClose && <FlexWidget style={{ width: 8 }} />}
            {allowClose && (
              <CloseButton target={key} label="✕" armedLabel="Đóng?" armed={armed} running={running} height={22} />
            )}
          </FlexWidget>
        );
      })}

      {snap && !hasPositions && maxRows > 0 && (
        <TextWidget text="Không có vị thế đang mở" style={{ fontSize: 12, color: C.muted }} />
      )}
      {hidden > 0 && <TextWidget text={`+${hidden} vị thế khác`} style={{ fontSize: 11, color: C.muted }} />}
    </FlexWidget>
  );
}
