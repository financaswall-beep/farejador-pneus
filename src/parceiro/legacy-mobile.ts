export type PartnerRequestHeaders = Record<string, string | string[] | undefined>;

export function isLegacyPartnerMobile(headers: PartnerRequestHeaders): boolean {
  const mobileHint = String(headers['sec-ch-ua-mobile'] ?? '').trim();
  if (mobileHint === '?1') return true;
  if (mobileHint === '?0') return false;
  const userAgent = String(headers['user-agent'] ?? '');
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile|Tablet/i.test(userAgent);
}
