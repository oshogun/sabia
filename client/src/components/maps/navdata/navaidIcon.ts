import { navdataPalette as P } from './navdataPalette';
import type { NavaidGlyph, NavaidSymbol } from './navaidGlyph';

/** Side of the square icon box holding the symbol, rose and label. */
export const NAVAID_ICON_PX = 56;
/** Above this many rose-eligible stations in one response no roses are drawn. */
export const ROSE_LIMIT = 40;

const C = P.navaid;
const STROKE = `fill="none" stroke="${C}" stroke-width="1.4" stroke-linejoin="round"`;
const DOT = `<circle r="1.4" fill="${C}"/>`;
const TACAN_PATH =
  'M6 0 L5.4 -1.04 L8.86 -3.04 L7.06 -6.16 L3.6 -4.16 L3 -5.2 L-3 -5.2 L-3.6 -4.16 L-7.06 -6.16 L-8.86 -3.04 ' +
  'L-5.4 -1.04 L-6 0 L-3 5.2 L-1.8 5.2 L-1.8 9.2 L1.8 9.2 L1.8 5.2 L3 5.2 Z';

function ringDots(radius: number, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (2 * Math.PI * i) / count;
    parts.push(`M${+(radius * Math.sin(t)).toFixed(2)} ${+(-radius * Math.cos(t)).toFixed(2)} h0`);
  }
  return parts.join(' ');
}

const NDB_DOTS = [ringDots(5, 8), ringDots(7.5, 12), ringDots(10, 16)].join(' ');

function roseTicks(): string {
  const parts: string[] = [];
  for (let k = 1; k < 36; k++) {
    const t = (k * 10 * Math.PI) / 180;
    const r = k % 9 === 0 ? 26 : 23;
    parts.push(
      `M${+(20 * Math.sin(t)).toFixed(2)} ${+(-20 * Math.cos(t)).toFixed(2)} ` +
      `L${+(r * Math.sin(t)).toFixed(2)} ${+(-r * Math.cos(t)).toFixed(2)}`,
    );
  }
  return parts.join(' ');
}

const ROSE_TICKS = roseTicks();

function symbolSvg(symbol: NavaidSymbol): string {
  switch (symbol) {
    case 'vor':
      return `<polygon points="6,0 3,-5.2 -3,-5.2 -6,0 -3,5.2 3,5.2" ${STROKE}/>${DOT}`;
    case 'vordme':
      return (
        `<rect x="-8" y="-7" width="16" height="14" ${STROKE}/>` +
        `<polygon points="5.5,0 2.75,-4.76 -2.75,-4.76 -5.5,0 -2.75,4.76 2.75,4.76" ${STROKE}/>${DOT}`
      );
    case 'dme':
      return `<rect x="-5.5" y="-5.5" width="11" height="11" ${STROKE}/>${DOT}`;
    case 'ndb':
      return (
        `<path d="${NDB_DOTS}" fill="none" stroke="${C}" stroke-width="1.6" stroke-linecap="round"/>` +
        `<circle r="2.2" ${STROKE}/><circle r="1" fill="${C}"/>`
      );
    case 'tacan':
      return `<path d="${TACAN_PATH}" ${STROKE}/>${DOT}`;
    case 'vortac':
      return `<path d="${TACAN_PATH}" fill="${C}" stroke="${C}" stroke-width="1.4" stroke-linejoin="round"/><circle r="1.4" fill="${P.halo}"/>`;
    case 'basic':
      return `<circle r="5" ${STROKE}/>${DOT}`;
  }
}

function roseSvg(deg: number): string {
  return (
    `<g transform="rotate(${deg.toFixed(1)})">` +
    `<circle r="20" fill="none" stroke="${C}" stroke-opacity=".6" stroke-width="1"/>` +
    `<path d="${ROSE_TICKS}" fill="none" stroke="${C}" stroke-opacity=".8" stroke-width="1"/>` +
    `<line x1="0" y1="-9" x2="0" y2="-27" stroke="${C}" stroke-width="1.6"/>` +
    `</g>`
  );
}

/** The divIcon html for one navaid: symbol, optional rose and label. identHtml must already be HTML-escaped. */
export function navaidIconHtml(g: NavaidGlyph, identHtml: string, frequency: string | null): string {
  const half = NAVAID_ICON_PX / 2;
  const left = g.rose ? 58 : half + Math.ceil(g.halfExtentPx) + 4;
  const textStyle = `color:${P.label};text-shadow:0 0 3px ${P.halo},0 0 3px ${P.halo}`;
  const line1 = g.classLetter ? `${identHtml} (${g.classLetter})` : identHtml;
  const rose = g.rose && g.roseRotationDeg !== null ? roseSvg(g.roseRotationDeg) : '';
  return (
    `<div data-navaid-symbol="${g.symbol}" data-navaid-rose="${g.roseRotationDeg === null ? 'none' : g.roseRotationDeg.toFixed(1)}" ` +
    `style="position:relative;width:${NAVAID_ICON_PX}px;height:${NAVAID_ICON_PX}px;pointer-events:none">` +
    `<svg width="${NAVAID_ICON_PX}" height="${NAVAID_ICON_PX}" viewBox="-${half} -${half} ${NAVAID_ICON_PX} ${NAVAID_ICON_PX}" ` +
    `style="position:absolute;left:0;top:0;filter:drop-shadow(0 0 2px ${P.halo})">${rose}${symbolSvg(g.symbol)}</svg>` +
    `<div style="position:absolute;left:${left}px;top:50%;transform:translateY(-50%);white-space:nowrap;line-height:1.15">` +
    `<div style="font:600 10px system-ui;${textStyle}">${line1}</div>` +
    (frequency !== null ? `<div style="font:500 9px system-ui;${textStyle}">${frequency}</div>` : '') +
    `</div></div>`
  );
}
