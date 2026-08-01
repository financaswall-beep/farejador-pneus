import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/entregas.html'), 'utf8');
const script = readFileSync(resolve('painel/public/entregas.js'), 'utf8');
const cardActions = readFileSync(resolve('painel/public/entregas.card-actions.js'), 'utf8');
const route = readFileSync(resolve('src/admin/entregador/route.ts'), 'utf8');
const staticRoutes = readFileSync(resolve('src/admin/entregador/route-static.ts'), 'utf8');
const queries = readFileSync(resolve('src/admin/entregador/queries.ts'), 'utf8');
const deliveryActions = readFileSync(resolve('src/admin/entregador/queries-delivery-actions.ts'), 'utf8');

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
    expect(staticRoutes).toContain("'/entregas/finalizar-rota-curva-v1.webp'");
    expect(staticRoutes).toContain("'entregas-finalizar-rota-curva-v1.webp'");
  });

  it('usa os botões ilustrados de navegação servidos localmente', () => {
    const assets = [
      'navigation-whatsapp-button-art-v2.webp',
      'navigation-waze-button-art-v2.webp',
      'navigation-google-maps-button-art-v5.webp',
    ];

    for (const asset of assets) {
      expect(statSync(resolve('painel/public/assets', asset)).size).toBeGreaterThan(4_000);
      expect(staticRoutes).toContain(`'${asset}'`);
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

  it('permite reordenar as paradas e preserva a ordem no próprio aparelho', () => {
    expect(html).toContain('Reordenar parada');
    expect(html).toContain('@click="moverParada(index, -1)"');
    expect(html).toContain('@click="moverParada(index, 1)"');
    expect(cardActions).toContain('moverParada(index, direcao)');
    expect(cardActions).toContain('farejador_entregador_ordem_');
    expect(script).toContain('aplicarOrdemSalva()');
  });

  it('expõe o fluxo pendente → saiu para entrega → entregue e permite desfazer a saída', () => {
    expect(html).toContain('Saiu para entrega');
    expect(html).toContain('Voltar para pendente');
    expect(html).toContain("atualizarStatus(d, 'dispatched')");
    expect(html).toContain("atualizarStatus(d, 'pending')");
    expect(route).toContain("z.enum(['pending', 'dispatched', 'delivered'])");
    expect(deliveryActions).toContain("($3 = 'delivered' AND o.delivery_status = 'dispatched')");
    expect(queries).toContain("SET trip_id = $3, delivery_status = 'pending'");
  });

  it('serve a foto aprovada somente pela rota autenticada do entregador', () => {
    expect(html).toContain('Foto do pneu aprovado');
    expect(cardActions).toContain('/api/entregas/fotos/${photoRequestId}/imagem');
    expect(route).toContain("'/api/entregas/fotos/:photoRequestId/imagem'");
    expect(route).toContain('getEntregadorProductPhotoImage');
    expect(deliveryActions).toContain('t.courier_collaborator_id = $3');
    expect(deliveryActions).toContain('p_photo.product_name = pr.tire_size');
  });
});
