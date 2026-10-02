import { describe, expect, it, vi } from 'vitest';
import { loadGoogleAdDetails } from '../../../src/marketing/google-ads-details.js';
const config = { environment: 'test' as const, customerId: '1234567890', clientId: 'c', clientSecret: 's', refreshToken: 'r',
  apiVersion: 'v25', scope: 'campaigns' as const, campaignIds: ['11'] };
const window = { since: '2026-09-25', until: '2026-10-01' };
const base = (id = '33') => ({ campaign: { id: '11', name: 'Pneus' }, adGroup: { id: '22' },
  adGroupAd: { status: 'ENABLED', ad: { id, name: 'Oferta', type: 'RESPONSIVE_DISPLAY_AD' } } });
const preview = (id = '33', resource = 'customers/1234567890/assets/77') => ({ ...base(id), adGroupAd: { ad: { id,
  responsiveDisplayAd: { businessName: '2W Pneus', headlines: [{ text: 'Pneus para moto' }],
    descriptions: [{ text: 'Consulte sua medida' }], marketingImages: [{ asset: resource }] } } } });
const metric = () => ({ ...base(), segments: { date: '2026-10-01' },
  metrics: { costMicros: '200000000', clicks: '100', impressions: '1000' } });
describe('Google Ads — prévias de mídia', () => {
  it('resolve recursos compartilhados em uma consulta e incorpora o texto do Display', async () => {
    const search = vi.fn().mockResolvedValueOnce([base(), base('34')]).mockResolvedValueOnce([metric()])
      .mockResolvedValueOnce([preview(), preview('34')]).mockResolvedValueOnce([{ asset: {
        resourceName: 'customers/1234567890/assets/77', imageAsset: { fullSize: { url: 'https://example.com/tire.jpg' } } } }]);
    const ads = await loadGoogleAdDetails(search, config, window);
    expect(ads[0]).toMatchObject({ investment: 200, cpc: 2, business_name: '2W Pneus',
      headlines: ['Pneus para moto'], image_url: 'https://example.com/tire.jpg' });
    expect(ads[1].image_url).toBe(ads[0].image_url);
    expect(search).toHaveBeenCalledTimes(4);
    expect(search.mock.calls[2][0]).toContain('campaign.id IN (11)');
    expect(search.mock.calls[3][0].match(/customers\/1234567890\/assets\/77/g)).toHaveLength(1);
  });
  it('preserva os indicadores se a consulta da prévia ou do recurso falhar', async () => {
    for (const assetFails of [false, true]) {
      const search = vi.fn().mockResolvedValueOnce([base()]).mockResolvedValueOnce([metric()]);
      if (assetFails) search.mockResolvedValueOnce([preview()]);
      search.mockRejectedValueOnce(new Error('Temporário'));
      expect((await loadGoogleAdDetails(search, config, window))[0]).toMatchObject({ investment: 200, clicks: 100, cpc: 2 });
    }
  });
  it('ignora mídia de outras campanhas, outras contas e nomes que poderiam injetar GAQL', async () => {
    for (const resource of ['customers/9999999999/assets/77', "customers/1234567890/assets/77') OR 1=1"]) {
      const search = vi.fn().mockResolvedValueOnce([base()]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...preview(), campaign: { id: '99' } }, preview('33', resource)]);
      const ads = await loadGoogleAdDetails(search, config, window);
      expect(ads[0].image_url).toBeNull(); expect(search).toHaveBeenCalledTimes(3);
    }
  });
  it('não aceita recurso que não foi solicitado ou URL de mídia insegura', async () => {
    for (const url of ['javascript:alert(1)', 'http://example.com/tire.jpg', 'https://secret@example.com/tire.jpg']) {
      const search = vi.fn().mockResolvedValueOnce([base()]).mockResolvedValueOnce([]).mockResolvedValueOnce([preview()])
        .mockResolvedValueOnce([{ asset: { resourceName: 'customers/1234567890/assets/88', imageAsset: { fullSize: { url: 'https://example.com/other.jpg' } } } },
          { asset: { resourceName: 'customers/1234567890/assets/77', imageAsset: { fullSize: { url } } } }]);
      expect((await loadGoogleAdDetails(search, config, window))[0].image_url).toBeNull();
    }
  });
  it('usa imagem direta quando fornecida, sem consultar recursos desnecessários', async () => {
    const inventory = base(); inventory.adGroupAd.ad.type = 'IMAGE_AD';
    const search = vi.fn().mockResolvedValueOnce([inventory]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...base(), adGroupAd: { ad: { id: '33', imageAd: { imageUrl: 'https://example.com/tire.jpg' } } } }]);
    expect((await loadGoogleAdDetails(search, config, window))[0].image_url).toBe('https://example.com/tire.jpg');
    expect(search).toHaveBeenCalledTimes(3);
  });
  it('divide bibliotecas maiores em lotes de recursos', async () => {
    const inventory = Array.from({ length: 201 }, (_, i) => base(String(i + 100)));
    const metadata = inventory.map(row => preview(row.adGroupAd.ad.id, `customers/1234567890/assets/${row.adGroupAd.ad.id}`));
    const search = vi.fn().mockResolvedValueOnce(inventory).mockResolvedValueOnce([]).mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await loadGoogleAdDetails(search, config, window)).toHaveLength(201);
    expect(search).toHaveBeenCalledTimes(5);
    expect(search.mock.calls[3][0].match(/customers\/1234567890\/assets\/\d+/g)).toHaveLength(200);
    expect(search.mock.calls[4][0].match(/customers\/1234567890\/assets\/\d+/g)).toHaveLength(1);
  });
});
