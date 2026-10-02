import type { GoogleAd } from './google-ads-details.js';
import type { GoogleAdsConfig } from './google-ads-client.js';

type TextAsset = { text?: string };
interface PreviewRow {
  campaign?: { id?: string };
  adGroup?: { id?: string };
  adGroupAd?: { ad?: {
    id?: string;
    responsiveDisplayAd?: {
      businessName?: string; headlines?: TextAsset[]; longHeadline?: TextAsset; descriptions?: TextAsset[];
      marketingImages?: Array<{ asset?: string }>; squareMarketingImages?: Array<{ asset?: string }>;
    };
    imageAd?: { imageUrl?: string; previewImageUrl?: string; imageAsset?: { asset?: string } };
  } };
}
interface AssetRow { asset?: { resourceName?: string; imageAsset?: { fullSize?: { url?: string } } } }
export function googlePreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Mídia é uma prévia de recursos, não uma captura da combinação entregue pelo Google.
 * https://developers.google.com/google-ads/api/docs/responsive-display-ads/get-responsive-display-ads
 * Falha na prévia não invalida a consulta de investimento e vendas. */
export async function enrichGoogleAdPreviews(search: <T>(query: string) => Promise<T[]>,
  config: GoogleAdsConfig, ads: GoogleAd[]): Promise<void> {
  const eligible = new Map(ads.filter(ad => ['RESPONSIVE_DISPLAY_AD', 'IMAGE_AD'].includes(ad.format)).map(ad => [ad.id, ad]));
  if (!eligible.size) return;
  const filter = config.scope === 'campaigns' ? ` AND campaign.id IN (${config.campaignIds.join(',')})` : '';
  let rows: PreviewRow[];
  try {
    rows = await search<PreviewRow>(`SELECT campaign.id, ad_group.id, ad_group_ad.ad.id,
      ad_group_ad.ad.responsive_display_ad.business_name, ad_group_ad.ad.responsive_display_ad.headlines,
      ad_group_ad.ad.responsive_display_ad.long_headline, ad_group_ad.ad.responsive_display_ad.descriptions,
      ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.responsive_display_ad.square_marketing_images,
      ad_group_ad.ad.image_ad.image_url, ad_group_ad.ad.image_ad.preview_image_url, ad_group_ad.ad.image_ad.image_asset.asset
      FROM ad_group_ad WHERE ad_group_ad.ad.type IN ('RESPONSIVE_DISPLAY_AD','IMAGE_AD')
      AND ad_group_ad.status IN ('ENABLED','PAUSED','REMOVED')${filter}`);
  } catch { return; }
  const references = new Map<string, GoogleAd[]>();
  for (const row of rows) {
    const data = row.adGroupAd?.ad;
    const ad = eligible.get(`${row.adGroup?.id}:${data?.id}`);
    if (!ad || row.campaign?.id !== ad.campaign_id) continue;
    const display = data?.responsiveDisplayAd;
    if (display) {
      ad.headlines = (display.headlines?.length ? display.headlines : [display.longHeadline ?? {}])
        .map(asset => (asset.text ?? '').slice(0, 300)).filter(Boolean);
      ad.descriptions = (display.descriptions ?? []).map(asset => (asset.text ?? '').slice(0, 1000)).filter(Boolean);
      ad.business_name = (display.businessName ?? '').slice(0, 300) || null;
    }
    ad.image_url = googlePreviewUrl(data?.imageAd?.imageUrl) ?? googlePreviewUrl(data?.imageAd?.previewImageUrl);
    if (ad.image_url) continue;
    const candidates = [...(display?.marketingImages ?? []), ...(display?.squareMarketingImages ?? []), data?.imageAd?.imageAsset];
    const resource = candidates.map(asset => asset?.asset).find(name =>
      typeof name === 'string' && new RegExp(`^customers/${config.customerId}/assets/\\d+$`).test(name));
    if (!resource) continue;
    references.set(resource, [...(references.get(resource) ?? []), ad]);
  }
  const names = [...references.keys()];
  for (let offset = 0; offset < names.length; offset += 200) {
    const batch = names.slice(offset, offset + 200), expected = new Set(batch);
    try {
      const assets = await search<AssetRow>(`SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset
        WHERE asset.resource_name IN (${batch.map(name => `'${name}'`).join(',')})`);
      for (const row of assets) {
        const name = row.asset?.resourceName;
        if (!name || !expected.has(name)) continue;
        const url = googlePreviewUrl(row.asset?.imageAsset?.fullSize?.url);
        for (const ad of references.get(name) ?? []) ad.image_url = url;
      }
    } catch { /* Indicadores permanecem disponíveis quando uma mídia não pode ser consultada. */ }
  }
}
