import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/caixa.html'), 'utf8');
const css = readFileSync(resolve('painel/public/caixa.css'), 'utf8');

describe('legibilidade da Operação da Loja', () => {
  it('publica a folha com uma versão própria para invalidar o cache', () => {
    expect(html).toContain('/operacao/caixa.css?v=20260814-finance-commissions1');
  });

  it('define uma escala mínima compartilhada para textos operacionais', () => {
    expect(css).toMatch(/--type-caption:\s*12px/);
    expect(css).toMatch(/--type-small:\s*14px/);
    expect(css).toMatch(/--type-body:\s*16px/);
    expect(css).toMatch(/--type-button:\s*15px/);
  });

  it('aplica a escala no login, vendas, caixa, estoque e modais', () => {
    expect(css).toMatch(/\.workplace-option small,[\s\S]*?font-size:\s*var\(--type-caption\)/);
    expect(css).toMatch(/\.sale-details > p,[\s\S]*?font-size:\s*var\(--type-small\)/);
    expect(css).toMatch(/\.payment-methods button,[\s\S]*?font-size:\s*var\(--type-small\)/);
    expect(css).toMatch(/\.stock-search input\s*\{\s*font-size:\s*var\(--type-body\)/);
    expect(css).toMatch(/\.stock-detail-actions button,[\s\S]*?font-size:\s*var\(--type-small\)/);
    expect(css).toMatch(/\.stock-count-field-label,[\s\S]*?font-size:\s*var\(--type-caption\)\s*!important/);
    expect(css).toMatch(/\.account-modal-sheet form input,[\s\S]*?font-size:\s*var\(--type-body\)/);
  });

  it('mantém alvos principais confortáveis para toque', () => {
    expect(css).toMatch(/\.chooser-back\s*\{\s*min-height:\s*44px/);
    expect(css).toMatch(/\.stock-detail-actions button\s*\{\s*min-height:\s*52px/);
    expect(css).toMatch(/\.bottom-nav button\s*\{\s*min-height:\s*56px/);
  });

  it('mantém o financeiro centralizado e proporcional no celular e no desktop', () => {
    expect(css).toContain("center top / 100% clamp(398px,100vw,410px)");
    expect(css).toMatch(/\.sales-app\.is-finance \.sales-header\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/\.finance-body\s*\{[^}]*width:\s*100%[^}]*padding:\s*9px 20px 6px[^}]*background:\s*#fff/);
    expect(css).toMatch(/\.finance-hero > strong\s*\{[^}]*font-size:\s*clamp\(38px,10\.5vw,53px\)/);
    expect(css).toMatch(/\.finance-cash-summary button\s*\{[^}]*display:\s*flex[^}]*min-height:\s*112px[^}]*justify-content:\s*center/);
    expect(css).toMatch(/\.finance-period-wrap\s*\{[^}]*min-height:\s*44px[^}]*margin:\s*0 auto 38px/);
    expect(css).toMatch(/\.finance-hero > p\s*\{[^}]*min-height:\s*32px[^}]*margin:\s*10px 0 0/);
    expect(css).toMatch(/\.sales-app\.is-finance \.sales-header\s*\{[^}]*min-height:\s*176px[^}]*padding-bottom:\s*48px/);
    expect(css).not.toMatch(/\.sales-app\.is-finance \.sales-logo/);
    expect(css).toMatch(/\.finance-cash-summary button \+ button\s*\{[^}]*color:\s*#dc2626/);
    expect(css).toMatch(/\.finance-pending-icon--document,\.finance-pending-icon--clock\s*\{[^}]*color:\s*#087246[^}]*background:\s*#eaf7f0/);
  });

  it('não volta a microtexto na largura compacta', () => {
    expect(css).toMatch(/@media \(max-width: 370px\)[\s\S]*?\.sale-card-heading > strong\s*\{\s*font-size:\s*var\(--type-small\)/);
    expect(css).toMatch(/@media \(max-width: 370px\)[\s\S]*?\.sale-status\s*\{[^}]*font-size:\s*var\(--type-caption\)/);
  });
});
