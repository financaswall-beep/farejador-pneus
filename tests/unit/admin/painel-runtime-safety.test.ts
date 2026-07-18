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

  it('invalida o cache dos modulos corrigidos', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');

    expect(html).toContain('app.atacado.js?v=20260718-frontfix1');
    expect(html).toContain('app.compras.acoes.js?v=20260718-frontfix1');
    expect(html).toContain('app.clientes.js?v=20260718-frontfix1');
  });
});
