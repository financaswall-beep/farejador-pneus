import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/caixa.html'), 'utf8');
const css = readFileSync(resolve('painel/public/caixa.css'), 'utf8');

describe('legibilidade da Operação da Loja', () => {
  it('publica a folha com uma versão própria para invalidar o cache', () => {
    expect(html).toContain('/caixa/caixa.css?v=20260811-entregas1');
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

  it('não volta a microtexto na largura compacta', () => {
    expect(css).toMatch(/@media \(max-width: 370px\)[\s\S]*?\.sale-card-heading > strong\s*\{\s*font-size:\s*var\(--type-small\)/);
    expect(css).toMatch(/@media \(max-width: 370px\)[\s\S]*?\.sale-status\s*\{[^}]*font-size:\s*var\(--type-caption\)/);
  });
});
