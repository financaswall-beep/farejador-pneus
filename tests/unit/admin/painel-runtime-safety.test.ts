import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type PainelModule = Record<string, (...args: unknown[]) => unknown>;

function loadPainelModule(file: string, moduleName: string): PainelModule {
  const sandbox = { window: { PAINEL_MODULES: {} as Record<string, () => PainelModule> } };
  const source = readFileSync(path.join(process.cwd(), 'painel', 'public', file), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES[moduleName]();
}

describe('seguranca de inicializacao do painel', () => {
  it('serve todos os modulos JavaScript declarados pelo HTML', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    const staticRoute = readFileSync('src/admin/painel/route-static.ts', 'utf8');
    const scripts = [...html.matchAll(
      /<script(?: defer)? src="\/admin\/painel\/([^"?]+\.js)(?:\?[^\"]*)?"/g,
    )].map((match) => match[1]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      if (script === 'app.js' || script.startsWith('vendor/')) continue;
      expect(staticRoute, `${script} precisa estar liberado em route-static.ts`)
        .toContain(`'${script}'`);
    }
  });

  it('mantem os formatadores seguros antes de existir uma selecao', () => {
    const atacado = loadPainelModule('app.atacado.js', 'atacado');
    const compras = loadPainelModule('app.compras.acoes.js', 'comprasAcoes');
    const clientes = loadPainelModule('app.clientes.js', 'clientes');

    expect(atacado.atacadoLastPurchase(null)).toBe('—');
    expect(atacado.atacadoStatus(null)).toMatchObject({ label: 'nunca comprou' });
    expect(atacado.reciboWhatsLink(null)).toBeNull();
    expect(compras.compraData(null)).toBe('—');
    expect(compras.vendaData(null)).toBe('—');
    expect(clientes.clienteLeadLane(null)).toBe('novo');
    expect(clientes.clienteLeadEspera(null)).toBe('Conversa encerrada');
  });

  it('nao exibe alertas sem ocorrencias e usa somente icones suportados', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');

    expect(html).not.toContain('data-lucide="package-clock"');
    expect(html).toContain('<span x-show="botMudas.length > 0" x-cloak');
    expect(html).toContain('<span x-show="botEscalados.length > 0" x-cloak');
  });

  it('da nome acessivel aos controles sem texto visivel', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');

    expect(html).toContain('aria-label="Buscar no painel"');
    expect(html).toContain('aria-label="Abrir notificações"');
    expect(html).toContain('aria-label="Buscar cliente ou conversa"');
  });

  it('protege o detalhe financeiro de Marketing antes do carregamento', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');

    expect(html).toContain(
      'marketingCampaignDetail?.financial?.pending_margin_orders || 0',
    );
    expect(html).not.toContain(
      '${marketingCampaignDetail.financial.pending_margin_orders}',
    );
  });

  it('usa dialogo interno nas mutacoes de compra e preserva os modulos novos', () => {
    const source = readFileSync('painel/public/app.compras.acoes.js', 'utf8');
    const purchaseActions = source.slice(
      source.indexOf('compraOpenDetails'),
      source.indexOf('async atacadoCancelSale'),
    );
    const html = readFileSync('painel/public/index.html', 'utf8');
    const staticRoute = readFileSync('src/admin/painel/route-static.ts', 'utf8');

    expect(purchaseActions).not.toContain('window.confirm');
    expect(purchaseActions).not.toContain('window.prompt');
    expect(purchaseActions).not.toContain('window.alert');
    expect(html).toContain('aria-labelledby="compra-dialog-title"');
    expect(staticRoute).toContain("'app.compras.relatorios.js'");
  });

  it('invalida o cache dos modulos corrigidos', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');

    expect(html).toContain('app.atacado.js?v=20260822-continuity1');
    expect(html).toContain('app.atacado.transfer.js?v=20260818-business-time1');
    expect(html).toContain('app.compras.relatorios.js?v=20260825-price-compare1');
    expect(html).toContain('app.compras.acoes.js?v=20260825-purchase-orders1');
    expect(html).toContain('app.core.js?v=20260823-partner-summary1');
    expect(html).toContain('app.clientes.js?v=20260822-continuity1');
    expect(html).toContain('app.clientes.identity.js?v=20260718-etapa9');
  });
});
