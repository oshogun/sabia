import { describe, expect, it } from 'vitest';
import { navaidGlyph } from './navaidGlyph';
import { navaidIconHtml } from './navaidIcon';
import type { FeatureNavaid } from '../../../types';

function nav(over: Partial<FeatureNavaid> = {}): FeatureNavaid {
  return {
    kind: 'V', ident: 'ZZV', region: 'ZZ', lat: 0, lon: 0, frequencyHz: null, name: null,
    navType: 3, isDme: true, isNav: true, isTacan: false, magvar: 20, ...over,
  };
}

describe('navaidIconHtml', () => {
  it('names the symbol and prints the rotation once in the data attribute and once in the transform', () => {
    const html = navaidIconHtml(navaidGlyph(nav()), 'ZZV', null);
    expect(html).toContain('data-navaid-symbol="vordme"');
    expect(html).toContain('data-navaid-rose="340.0"');
    expect(html).toContain('rotate(340.0)');
    expect(html).toContain('r="20"');
  });
  it('draws the escaped ident with its class letter and the second line only with a frequency', () => {
    const g = navaidGlyph(nav());
    expect(navaidIconHtml(g, '&#60;X', null)).toContain('&#60;X (H)</div>');
    expect(navaidIconHtml(g, 'ZZV', null)).not.toContain('font:500 9px');
    expect(navaidIconHtml(g, 'ZZV', '116.50')).toContain('>116.50</div>');
  });
  it('has no rose elements when the glyph has no rose', () => {
    const html = navaidIconHtml(navaidGlyph(nav({ magvar: null })), 'ZZV', null);
    expect(html).toContain('data-navaid-rose="none"');
    expect(html).not.toContain('r="20"');
    expect(html).not.toContain('rotate(');
  });
});
