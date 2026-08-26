import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Marketing — primeira tela da matriz', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const front = readFileSync(resolve('painel/public/app.marketing.js'), 'utf8');
  const chartFront = readFileSync(resolve('painel/public/app.marketing.chart.js'), 'utf8');
  const campaignsFront = readFileSync(resolve('painel/public/app.marketing.campaigns.js'), 'utf8');
  const campaignDetailFront = readFileSync(resolve('painel/public/app.marketing.campaign-detail.js'), 'utf8');
  const journeysFront = readFileSync(resolve('painel/public/app.marketing.journeys.js'), 'utf8');
  const integrationsFront = readFileSync(resolve('painel/public/app.marketing.integrations.js'), 'utf8');
  const route = readFileSync(resolve('src/admin/painel/route-marketing.ts'), 'utf8');
  const staticRoute = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');

  it('preserva o molde do Estoque com banner real e subabas superiores', () => {
    const banner = statSync(resolve('painel/public/assets/marketing-hero.webp'));
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('min-h-[148px]');
    expect(marketingHtml).toContain('/admin/painel/assets/marketing-hero.webp?v=20260725-marketing-visao1');
    expect(marketingHtml).toContain('aria-label="Seções de Marketing"');
    for (const label of [
      'Visão geral',
      'Campanhas',
      'Criativos',
      'Jornadas',
      'Geografia e demanda',
      'Integrações',
    ]) expect(front).toContain(label);
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });

  it('liga o front a um endpoint owner-only sem expor credenciais', () => {
    expect(front).toContain('/admin/api/marketing/overview?period=');
    expect(route).toContain("{ preHandler: requireAdminOwner }");
    expect(route).toContain("z.enum(['7d', '30d'])");
    expect(staticRoute).toContain("'app.marketing.js'");
    expect(staticRoute).toContain("'app.marketing.chart.js'");
    expect(readFileSync(resolve('painel/public/app.montagem.js'), 'utf8'))
      .toContain('window.PAINEL_MODULES.marketingChart');
    expect(html).toContain('/admin/painel/app.marketing.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/app.marketing.chart.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/app.marketing.campaigns.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/app.marketing.campaign-detail.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/app.marketing.journeys.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/app.marketing.integrations.js?v=20260821-marketing-audit1');
    expect(html).toContain('/admin/painel/tailwind.css?v=20260826-performance1');
    expect(staticRoute).toContain("fastify.get('/admin/painel/assets/marketing-hero.webp'");
    expect(staticRoute).toContain("'app.marketing.campaigns.js'");
    expect(staticRoute).toContain("'app.marketing.campaign-detail.js'");
    expect(staticRoute).toContain("'app.marketing.journeys.js'");
    expect(staticRoute).toContain("'app.marketing.integrations.js'");
    expect(front).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
    expect(html).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });

  it('não transforma ausência de atribuição em venda zero', () => {
    expect(front).toContain("metrics.attributed_sales ?? '—'");
    expect(front).toContain("metrics.net_after_media == null ? 'Não calculada'");
    expect(html).toContain('zero vendas atribuídas não significa zero vendas realizadas');
    expect(html).toContain('A venda só entra aqui depois de haver vínculo rastreável');
  });

  it('apresenta uma leitura fluida e marcas reais sem alterar o contrato de dados', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('id="chartMarketingRhythm"');
    expect(chartFront).toContain("label: 'Investimento (R$)'");
    expect(chartFront).toContain("label: 'Conversas'");
    expect(chartFront).toContain("yAxisID: 'investment'");
    expect(chartFront).toContain("yAxisID: 'conversations'");
    expect(chartFront).toContain('borderDash: [6, 5]');
    expect(front).not.toContain('marketingSeriesPoints');
    expect(marketingHtml).toContain('marketingJourneyLine');
    expect(marketingHtml).toContain('Uma trilha contínua; nenhuma etapa avança sem evidência');
    expect(marketingHtml).toContain('/assets/brands/facebook.svg');
    expect(marketingHtml).toContain('/assets/brands/instagram.svg');
    expect(marketingHtml).toContain('/assets/brands/google-ads.svg');
    expect(marketingHtml).toContain('<title>TikTok</title>');
    expect(marketingHtml).toContain('grid grid-cols-1 gap-2 sm:grid-cols-3');
    expect(marketingHtml).toContain('background:conic-gradient(#047857');
    expect(marketingHtml).toContain('<strong>Próximo passo:</strong> validar atribuição multicanal');
    expect(marketingHtml).toContain('data-marketing-channel-filter-mock');
    expect(marketingHtml).toContain('Meta somente — Google e TikTok não têm conector neste módulo');
    expect(marketingHtml).toContain('disabled aria-pressed="false" title="Sem conector"');
    expect(marketingHtml).not.toContain('<section x-show="marketingIsMock()" x-cloak data-marketing-channel-filter-mock');
    expect(marketingHtml).toContain('grid grid-cols-1 gap-4 lg:grid-cols-12');
    expect(marketingHtml).toContain('shadow-sm lg:col-span-8');
    expect(marketingHtml).toContain('shadow-sm lg:col-span-7');
    expect(marketingHtml).toContain('absolute right-3 top-3 z-20');
    expect(marketingHtml).not.toContain('absolute right-3 top-3 z-30');
    expect(marketingHtml).toContain('2xl:grid-cols-8');
    expect(marketingHtml).not.toContain('h-4.5 w-4.5');
    expect(front).toContain("'border-emerald-300 bg-emerald-100/80 text-emerald-950'");
    expect(front).not.toContain("'border-rose-200 bg-rose-50 text-rose-700'");
  });

  it('remove a subaba redundante Canais e direciona gestão para Integrações', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(front).not.toContain("{ id: 'canais', label: 'Canais' }");
    expect(front).not.toContain("target: 'canais'");
    expect(marketingHtml).not.toContain('data-marketing-channels-screen');
    expect(marketingHtml).toContain("marketingNavigate('integracoes')");
    expect(marketingHtml).toContain("marketingTab !== 'visao' && marketingTab !== 'campanhas' && marketingTab !== 'jornadas' && marketingTab !== 'integracoes'");
  });

  it('implementa Jornadas com ledger multicanal e denominador comercial explícito', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('data-marketing-journeys-screen');
    expect(marketingHtml).toContain('Jornada rastreável');
    expect(marketingHtml).toContain('Mapa da jornada');
    expect(marketingHtml).toContain('Jornada por campanha');
    expect(marketingHtml).toContain('Ausência de atribuição não é tratada como zero vendas');
    expect(journeysFront).toContain('/admin/api/marketing/journeys?period=');
    expect(journeysFront).toContain("id: 'order_coverage'");
    expect(marketingHtml).toContain('Last-click em até 7 dias');
    expect(marketingHtml).toContain('Uma venda por clique');
    expect(journeysFront).toContain("marketingJourneySourceLabel(source)");
    expect(route).toContain("fastify.get('/admin/api/marketing/journeys'");
    expect(journeysFront).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
    expect(marketingHtml).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });

  it('implementa Campanhas da Meta e mantém canais sem conector desabilitados', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('data-marketing-campaigns-screen');
    expect(marketingHtml).toContain("marketingCampaignSetChannel('all')");
    expect(marketingHtml).toContain("marketingCampaignSetChannel('meta')");
    expect(marketingHtml).toContain('title="Sem conector"');
    expect(marketingHtml).toContain('Decisão por campanha');
    expect(marketingHtml).toContain('data-marketing-campaign-channel-icon');
    expect(marketingHtml).toContain('Aguardando atribuição');
    expect(marketingHtml).toContain('Impressões');
    expect(marketingHtml).toContain('Cliques');
    expect(marketingHtml).toContain('Custos conciliados');
    expect(marketingHtml).toContain('Custo pendente');
    expect(marketingHtml).toContain('Escopo financeiro');
    expect(marketingHtml).toContain('<option value="pending">Pendente</option>');
    expect(marketingHtml).toContain('<option value="matrix">Matriz</option>');
    expect(marketingHtml).toContain('<option value="external">Externa</option>');
    expect(marketingHtml).toContain('Nenhuma verba é alterada automaticamente');
    expect(campaignsFront).toContain('/admin/api/marketing/campaigns?period=');
    expect(campaignsFront).toContain('&channel=');
    expect(campaignsFront).toContain('marketingCampaignSetChannel(channel)');
    expect(campaignsFront).toContain('updateMarketingCampaignScope(row, event)');
    expect(campaignsFront).toContain('/admin/api/marketing/ad-accounts/${encodeURIComponent(row.ad_account_id)}');
    expect(campaignsFront).toContain("marketingCampaignChannel === channel");
    expect(route).toContain("fastify.get('/admin/api/marketing/campaigns'");
    expect(route).toContain("fastify.put(\n    '/admin/api/marketing/ad-accounts/:adAccountId/campaigns/:campaignId/scope'");
    expect(route).toContain("z.enum(['all', 'meta', 'google', 'tiktok'])");
    expect(campaignsFront).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
    expect(marketingHtml).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });

  it('abre o detalhe real ao clicar numa campanha e preserva o retorno à lista', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('data-marketing-campaign-detail-screen');
    expect(marketingHtml).toContain('@click="openMarketingCampaignDetail(row)"');
    expect(marketingHtml).toContain('Voltar para campanhas');
    expect(marketingHtml).toContain('Eficiência do atendimento');
    expect(marketingHtml).toContain('Raio-X financeiro');
    expect(marketingHtml).toContain('Vendas atribuídas à campanha');
    expect(marketingHtml).toContain('Qualidade da atribuição');
    expect(marketingHtml).toContain('Resultado por anúncio');
    expect(marketingHtml).toContain('Leitura para decisão');
    expect(marketingHtml).toContain('Abrir no Gerenciador');
    expect(campaignDetailFront).toContain('Custos, repasses e operação');
    expect(marketingHtml).not.toContain('Entrega ao longo do período');
    expect(marketingHtml).not.toContain('Diagnóstico de mídia');
    expect(campaignDetailFront).toContain('/admin/api/marketing/campaigns/${encodeURIComponent(campaignId)}?period=');
    expect(campaignDetailFront).toContain('closeMarketingCampaignDetail()');
    expect(route).toContain("fastify.get('/admin/api/marketing/campaigns/:campaignId'");
    expect(campaignDetailFront).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });

  it('implementa Integrações sem expor segredo nem inventar conexão ou auditoria', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('data-marketing-integrations-screen');
    expect(marketingHtml).toContain('Fluxo de dados');
    expect(marketingHtml).toContain('Qualidade e segurança');
    expect(marketingHtml).toContain('Padrão de rastreamento');
    expect(marketingHtml).toContain('Auditoria de integrações');
    expect(marketingHtml).toContain('Nenhuma venda é atribuída sem vínculo rastreável');
    expect(integrationsFront).toContain('/admin/api/marketing/integrations?period=');
    expect(integrationsFront).toContain('marketingUtmUrl()');
    expect(integrationsFront).toContain('navigator.clipboard.writeText');
    expect(integrationsFront).toContain("this.apiPost('/admin/api/marketing/sync'");
    expect(integrationsFront).toContain("this.apiPost('/admin/api/marketing/reconcile'");
    expect(integrationsFront).toContain("this.apiPost('/admin/api/marketing/capi/test'");
    expect(integrationsFront).toContain("this.apiPost('/admin/api/marketing/capi/test/whatsapp'");
    expect(integrationsFront).toContain('META_CAPI_WHATSAPP_DATASET_ID');
    expect(integrationsFront).toContain('META_CAPI_WHATSAPP_ACCESS_TOKEN');
    expect(integrationsFront).toContain('A Meta recusou o teste:');
    expect(integrationsFront).toContain('marketingIntegrationAuditLabel(eventType)');
    expect(route).toContain("fastify.get('/admin/api/marketing/integrations'");
    expect(route).toContain("fastify.post('/admin/api/marketing/sync'");
    expect(route).toContain('sendLatestCapiTestPurchase');
    expect(route).toContain('sendLatestWhatsappReferralTestPurchase');
    expect(route).toContain("payload: { status: 'failed', reason }");
    expect(integrationsFront).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
    expect(marketingHtml).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });
});
