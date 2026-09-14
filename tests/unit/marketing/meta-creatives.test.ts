import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMetaCreativeCache, getMetaCreatives, getMetaCreativePreview, parseMetaCreative, safeMetaImageUrl } from '../../../src/marketing/meta-creatives.js';
const config = { adAccountId: 'act_123', accessToken: 'test-private-token', apiVersion: 'v21.0' };
afterEach(() => { clearMetaCreativeCache(); vi.unstubAllGlobals(); });
describe('leitura dos criativos da Meta', () => {
  it('identifica imagem, vídeo e carrossel sem repassar o payload da Meta', () => {
    const base = { id: '456', account_id: '123', name: 'Anúncio', effective_status: 'PAUSED' };
    expect(parseMetaCreative({ ...base, creative: { image_hash: 'hash', thumbnail_url: 'https://scontent.xx.fbcdn.net/image.jpg' } }, config))
      .toMatchObject({ format: 'image', status: 'PAUSED', image_url: 'https://scontent.xx.fbcdn.net/image.jpg' });
    expect(parseMetaCreative({ ...base, creative: { object_story_spec: { video_data: { video_id: '77' } } } }, config)?.format).toBe('video');
    expect(parseMetaCreative({ ...base, creative: { object_story_spec: { link_data: { child_attachments: [{ picture: 'https://scontent.xx.fbcdn.net/p.jpg' }] } } } }, config)?.format).toBe('carousel');
    expect(parseMetaCreative({ ...base, account_id: '999' }, config)).toBeNull();
  });
  it.each(['javascript:alert(1)', 'https://fbcdn.net.evil.test/photo', 'https://127.0.0.1/photo',
    'https://facebook.com/photo?access_token=private', 'https://user:pass@fbcdn.net/photo', 'https://fbcdn.net:444/photo'])('recusa mídia insegura: %s', (url) => {
    expect(safeMetaImageUrl(url)).toBeNull();
  });
  it('usa autorização no header e cache, sem token nas URLs nem no resultado', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      '456': { id: '456', account_id: '123', name: 'Teste', creative: { video_id: '777' } },
      '999': { id: '999', account_id: '999', name: 'Outra conta' },
    })));
    const first = await getMetaCreatives(config, ['456', '999'], fetcher);
    expect(first.ads).toHaveLength(1); expect(first.unavailable).toBe(1);
    await getMetaCreatives(config, ['456', '999'], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).not.toContain(config.accessToken);
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${config.accessToken}`);
    expect(JSON.stringify(first)).not.toContain(config.accessToken);
  });
  it('preserva a consulta mesmo quando a Meta recusa as mídias', async () => {
    const result = await getMetaCreatives(config, ['456'], vi.fn().mockRejectedValue(new Error('permission denied')));
    expect(result).toEqual({ ads: [], unavailable: 1 });
  });
  it('abre apenas prévia oficial e usa o gerenciador se vier HTML inesperado', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ body: '<iframe src="https://evil.test/x"></iframe>' }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await getMetaCreativePreview(config, '456')).toContain('https://adsmanager.facebook.com/');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?id=456&amp;key=signed"></iframe>' }] })));
    expect(await getMetaCreativePreview(config, '456')).toBe('https://www.facebook.com/ads/api/preview_iframe.php?id=456&key=signed');
  });
});
