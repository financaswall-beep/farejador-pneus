import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('Catálogo na Operação da Loja', () => {
  const html = source('painel/public/caixa.html');
  const core = source('painel/public/caixa-catalog.js');
  const view = source('painel/public/caixa-catalog-view.js');
  const brandCatalog = source('painel/public/caixa-brand-catalog.js');
  const navigation = source('painel/public/caixa-sales.js');
  const modules = source('painel/public/caixa-modules.js');
  const price = source('painel/public/caixa-stock-price.js');
  const css = source('painel/public/caixa.css');
  const staticRoute = source('src/admin/caixa/route-static.ts');
  const partnerCatalogRoute = source('src/parceiro/route-panel-catalog.ts');
  const partnerPriceRoute = source('src/parceiro/route-operation-stock-price.ts');
  const scripts = core + '\n' + view;

  it('vive no mesmo casco do /operacao e segue a permissão de Estoque', () => {
    expect(html).toContain('id="operation-catalog-panel"');
    expect(html).toContain('id="nav-catalog"');
    expect(html).toContain('/operacao/caixa-catalog.js?v=20260824-operation-catalog1');
    expect(html).toContain('/operacao/caixa-catalog-view.js?v=20260824-operation-catalog1');
    expect(html.indexOf('/operacao/caixa-catalog.js')).toBeLessThan(
      html.indexOf('/operacao/caixa-catalog-view.js'),
    );
    expect(staticRoute).toContain("'/operacao/caixa-catalog.js'");
    expect(staticRoute).toContain("'/operacao/caixa-catalog-view.js'");
    expect(modules).toContain("catalog: 'estoque'");
    expect(modules).toContain("setNavigationVisibility('nav-catalog', canModule('estoque'))");
    expect(modules).toContain("window.location.hash === '#catalogo'");
    expect(navigation).toContain("showTab('catalog')");
  });

  it('usa exatamente os mesmos 15 arquivos de logo já usados pela Matriz', () => {
    const assets = readdirSync(resolve('painel/public/assets/catalog-brands'))
      .filter((file) => file.endsWith('.webp')).sort();
    expect(assets).toEqual([
      'bridgestone.webp', 'ceat.webp', 'dunlop.webp', 'ira.webp', 'irc.webp',
      'kenda.webp', 'levorin.webp',
      'maggion.webp', 'metzeler.webp', 'michelin.webp', 'mitas.webp',
      'pirelli.webp', 'rinaldi.webp', 'technic.webp', 'vipal.webp',
    ]);
    expect(brandCatalog).toContain('Caixa.catalogLogoBrands');
    expect(view).toContain('Caixa.catalogBrandLogo(brand)');
    expect(core).toContain('ordered.push(present.get(key) || brand)');
    expect(view).toContain("image.addEventListener('error'");
    expect(view).toContain('document.body.appendChild(fitmentModal)');
  });

  it('separa catálogo central de saldo e preço locais sem vazar custo da Matriz', () => {
    expect(core).toContain("Caixa.operationPath('painel/catalogo?' + params.toString())");
    expect(core).toContain("Caixa.operationPath('operacao/estoque')");
    expect(core).toContain("'/compatibilidade'");
    expect(scripts).not.toMatch(/\/admin\/api|average_cost|unit_cost|gross_profit|margin|wholesale_stock/i);
    expect(html).toContain('O preço e o estoque exibidos são somente desta unidade.');
    expect(partnerCatalogRoute).toContain(
      "const catalogScreen = [requirePartnerAuth, requireScreen('catalogo')]",
    );
  });

  it('permite alteração de preço só ao dono e escolhe explicitamente linhas duplicadas', () => {
    expect(view).toContain("helper.isOwner() && entries.length > 0");
    expect(view).toContain("if (entries.length === 1)");
    expect(view).toContain("if (entries.length < 2) return");
    expect(view).toContain('Caixa.openStockPrice(helper.selectedStockRow(row, entry))');
    expect(partnerPriceRoute).toContain("preHandler: [requirePartnerAuth, requireScreen('estoque')]");
    expect(price).toContain('if (Caixa.loadOperationCatalog) await Caixa.loadOperationCatalog(1)');
  });

  it('é responsivo, não duplica IDs do checkout e respeita o teto modular', () => {
    expect(html.match(/id="operation-catalog-list"/g)).toHaveLength(1);
    expect(html).not.toContain('id="catalog-list" class="operation-catalog');
    expect(css).toContain('@media (max-width: 430px)');
    expect(css).toContain('@media (max-width: 360px)');
    expect(css).toContain('@media (max-width: 320px)');
    expect(css).toContain('.operation-catalog-card {');
    expect(view).toContain('visible(list, true)');
    expect(core.trimEnd().split(/\r?\n/)).toHaveLength(175);
    expect(view.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(300);
  });
});
