import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: { MARKETING_META_ENABLED: false } }));
import { enrichMetaReviewRows } from '../../../src/marketing/meta-review-metadata.js';

const config = { adAccountId: 'act_123', accessToken: 'test-token', apiVersion: 'v21.0' };
const row = { ad_account_id: 'act_123', ad_id: '11', campaign_id: '22', scope: 'pending', can_decide: true,
  current_month_spend: '15.00', ad_name: null, campaign_name: null, effective_status: 'ARCHIVED' };

describe('identificação legível dos anúncios em revisão', () => {
  it('acrescenta nome, campanha e prévia sem alterar classificação, permissão ou valores', async () => {
    const provider = vi.fn().mockResolvedValue({ ads: [{ id: '11', campaign_id: '22', name: 'Pneu 90/90-18', campaign_name: 'Pneus novembro',
      title: 'Oferta de pneus', body: 'Consulte a disponibilidade', image_url: 'https://scontent.xx.fbcdn.net/tire.jpg', format: 'image' }], unavailable: 0 });
    const [result] = await enrichMetaReviewRows([row], { config, provider });
    expect(result).toMatchObject({ ad_name: 'Pneu 90/90-18', campaign_name: 'Pneus novembro', metadata_status: 'available',
      preview: { title: 'Oferta de pneus', body: 'Consulte a disponibilidade', image_url: 'https://scontent.xx.fbcdn.net/tire.jpg' },
      scope: 'pending', can_decide: true, current_month_spend: '15.00' });
    expect(row.ad_name).toBeNull(); expect(provider).toHaveBeenCalledWith(config, ['11']);
    expect(JSON.stringify(result)).not.toContain(config.accessToken);
  });
  it('preserva nomes do histórico se a Meta falhar e distingue ausência de dados', async () => {
    const provider = vi.fn().mockRejectedValue(new Error('private credential detail'));
    const results = await enrichMetaReviewRows([{ ...row, ad_name: 'Nome registrado', campaign_name: 'Campanha registrada' }, { ...row, ad_id: '12' }], { config, provider });
    expect(results[0]).toMatchObject({ ad_name: 'Nome registrado', campaign_name: 'Campanha registrada', metadata_status: 'history', preview: null });
    expect(results[1]).toMatchObject({ ad_name: null, campaign_name: null, metadata_status: 'unavailable', preview: null });
    expect(JSON.stringify(results)).not.toContain('private');
  });
  it('consulta somente IDs das linhas da conta configurada e não mistura anúncios que mudaram de campanha', async () => {
    const provider = vi.fn().mockResolvedValue({ ads: [{ id: '11', campaign_id: '99', name: 'Outra campanha' },
      { id: '13', campaign_id: '22', name: 'Não solicitado' }], unavailable: 0 });
    const results = await enrichMetaReviewRows([row, { ...row, ad_account_id: 'act_999' }], { config, provider });
    expect(provider).toHaveBeenCalledWith(config, ['11']);
    expect(results[0]).toMatchObject({ ad_name: null, campaign_name: null, metadata_status: 'changed', preview: null });
    expect(results[1]).toMatchObject({ ad_name: null, metadata_status: 'unavailable', preview: null });
  });
  it('não chama o provedor sem configuração e recusa miniaturas fora dos domínios Meta', async () => {
    const provider = vi.fn(); await enrichMetaReviewRows([row], { config: null, provider }); expect(provider).not.toHaveBeenCalled();
    provider.mockResolvedValue({ ads: [{ id: '11', campaign_id: '22', name: 'Pneus', image_url: 'https://evil.test/photo.jpg' }], unavailable: 0 });
    expect((await enrichMetaReviewRows([row], { config, provider }))[0].preview?.image_url).toBeNull();
  });
  it('não apresenta identificadores técnicos salvos como se fossem nomes recuperados', async () => {
    const [result] = await enrichMetaReviewRows([{ ...row, ad_name: '11', campaign_name: '22' }], { config: null });
    expect(result).toMatchObject({ ad_name: null, campaign_name: null, metadata_status: 'unavailable' });
  });
});
