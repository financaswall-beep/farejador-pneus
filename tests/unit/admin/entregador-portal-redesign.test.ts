import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/entregas.html'), 'utf8');
const script = readFileSync(resolve('painel/public/entregas.js'), 'utf8');
const route = readFileSync(resolve('src/admin/entregador/route.ts'), 'utf8');

describe('portal mobile do entregador', () => {
  it('organiza rota, paradas e fechamento sem remover as ações operacionais', () => {
    expect(html).toContain('class="delivery-app-shell"');
    expect(html).toContain('Rota em andamento');
    expect(html).toContain('Suas paradas');
    expect(html).toContain('Confirmar entrega');
    expect(html).toContain('Não entreguei');
    expect(html).toContain('Fotografar comprovante');
    expect(html).toContain('Finalizar rota do dia');
    expect(html).toContain('@click="abrirRota()"');
    expect(html).toContain('@click="pedirFechamentoRota()"');
  });

  it('usa a arte do fechamento como fundo sem trocar os controles funcionais', () => {
    const artwork = resolve('painel/public/assets/entregas-finalizar-rota-curva-v1.webp');

    expect(statSync(artwork).size).toBeGreaterThan(30_000);
    expect(html).toContain("url('/entregas/finalizar-rota-curva-v1.webp')");
    expect(html).toContain('class="delivery-close-overlay-field delivery-close-overlay-field--km"');
    expect(html).toContain('x-model="fecharForm.km_end"');
    expect(html).toContain('x-model="fecharForm.fuel_spent"');
    expect(html).toContain('@change="subirComprovante($event)"');
    expect(route).toContain("'/entregas/finalizar-rota-curva-v1.webp'");
    expect(route).toContain("'assets/entregas-finalizar-rota-curva-v1.webp'");
  });

  it('usa os botões ilustrados de navegação servidos localmente', () => {
    const assets = [
      'navigation-whatsapp-button-art-v2.webp',
      'navigation-waze-button-art-v2.webp',
      'navigation-google-maps-button-art-v5.webp',
    ];

    for (const asset of assets) {
      expect(statSync(resolve('painel/public/assets', asset)).size).toBeGreaterThan(4_000);
      expect(route).toContain(`'assets/${asset}'`);
    }

    expect(html).toContain('src="/entregas/button-whatsapp-v2.webp"');
    expect(html).toContain('src="/entregas/button-waze-v2.webp"');
    expect(html).toContain('src="/entregas/button-google-maps-v5.webp"');
    expect(html).toContain(':href="whatsUrl(d)"');
    expect(html).toContain(':href="wazeUrl(d)"');
    expect(html).toContain(':href="mapsUrl(d)"');
  });

  it('calcula o progresso apenas a partir das entregas da rota aberta', () => {
    expect(script).toContain('entregasConcluidas()');
    expect(script).toContain('entregasPendentes()');
    expect(script).toContain('percentualRota()');
    expect(script).toContain("d.delivery_status === 'delivered'");
  });
});
