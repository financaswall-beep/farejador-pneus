import { createHash } from 'node:crypto';
import { env } from '../shared/config/env.js';
import { fetchGoogleAds, type GoogleAdsSnapshot } from './google-ads.js';
import { GoogleAdsError, type GoogleAdsConfig } from './google-ads-client.js';
import type { MarketingPeriod } from '../admin/painel/marketing-meta.js';

export interface GoogleAdsSettings {
  enabled: boolean;
  config: Partial<GoogleAdsConfig>;
}
export interface GoogleAdsReport {
  environment: 'prod' | 'test';
  status: 'disabled' | 'not_configured' | 'connected' | 'error';
  account_masked: string | null;
  missing: string[];
  error_code: string | null;
  detail: string;
  data: GoogleAdsSnapshot | null;
}

export function googleAdsSettings(): GoogleAdsSettings {
  return { enabled: env.GOOGLE_ADS_ENABLED, config: {
    environment: env.FAREJADOR_ENV, customerId: env.GOOGLE_ADS_CUSTOMER_ID,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    clientId: env.GOOGLE_ADS_CLIENT_ID, clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN, apiVersion: env.GOOGLE_ADS_API_VERSION,
    serviceAccountJson: env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON,
    scope: env.GOOGLE_ADS_SCOPE,
    campaignIds: [...new Set((env.GOOGLE_ADS_CAMPAIGN_IDS || '').split(',').map(id => id.trim()).filter(Boolean))],
  } };
}

const messages: Record<string, string> = {
  authorization_expired: 'A autorização do Google expirou ou foi revogada. Autorize novamente a conta.',
  oauth_failed: 'Não foi possível autenticar no Google. Confira a credencial configurada no servidor.',
  invalid_service_account: 'O JSON da conta de serviço está inválido. Configure o arquivo completo, não apenas o ID da chave.',
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: 'O projeto Google Cloud ainda não tem acesso à API para contas de produção.',
  USER_PERMISSION_DENIED: 'A credencial não tem acesso à conta escolhida. Confira a conta e, se houver, o ID da conta de administrador.',
  ACTION_NOT_PERMITTED: 'O Google recusou o acesso. Confira a aprovação do projeto e as permissões da conta.',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'A autorização precisa incluir acesso ao Google Ads.',
  CUSTOMER_NOT_ENABLED: 'A conta de anúncios não está habilitada no Google Ads.',
  manager_account: 'Selecione a conta de anúncios da 2W. Uma conta de administrador não possui métricas próprias.',
  unsupported_currency: 'Esta integração exige uma conta em reais (BRL). Valores de outras moedas não serão somados.',
  environment_mismatch: 'O ambiente do Farejador e o tipo da conta Google (produção/teste) são diferentes.',
  invalid_config: 'Confira os IDs da conta, o escopo e as credenciais no servidor.',
  quota_exceeded: 'O limite temporário de consultas do Google foi atingido. Tente novamente mais tarde.',
  access_denied: 'O Google recusou o acesso à conta. Confira a autorização e o projeto Google Cloud.',
};
const cache = new Map<string, { expires: number; value: Promise<GoogleAdsReport> }>();
export function clearGoogleAdsReportCache(): void {cache.clear();}

/** Cache curto de leitura: não publica despesas nem altera o motor de atribuição da Meta. */
export async function getGoogleAdsReport(period: MarketingPeriod = '30d', options: {
  settings?: GoogleAdsSettings;
  fetcher?: typeof fetch;
  now?: Date;
  bypassCache?: boolean;
} = {}): Promise<GoogleAdsReport> {
  const settings = options.settings ?? googleAdsSettings();
  const c = settings.config;
  const base: GoogleAdsReport = {
    environment: c.environment ?? env.FAREJADOR_ENV,
    status: 'not_configured', account_masked: c.customerId ? `••••••${c.customerId.slice(-4)}` : null,
    missing: [], error_code: null, detail: '', data: null,
  };
  const fields: Array<[keyof GoogleAdsConfig, string]> = [
    ['customerId', 'GOOGLE_ADS_CUSTOMER_ID'], ['scope', 'GOOGLE_ADS_SCOPE'],
  ];
  base.missing = fields.filter(([key]) => !c[key]).map(([, label]) => label);
  if (!c.serviceAccountJson && (!c.clientId || !c.clientSecret || !c.refreshToken)) {
    base.missing.push('GOOGLE_ADS_SERVICE_ACCOUNT_JSON');
  }
  if (c.scope === 'campaigns' && !c.campaignIds?.length) base.missing.push('GOOGLE_ADS_CAMPAIGN_IDS');
  if (!settings.enabled) base.missing.unshift('GOOGLE_ADS_ENABLED');
  if (base.missing.length) return { ...base, status: settings.enabled ? 'not_configured' : 'disabled',
    detail: 'A conexão aguarda configuração no servidor e autorização da conta Google Ads.' };
  const now = options.now ?? new Date();
  const key = createHash('sha256').update(JSON.stringify([c, period, now.toISOString().slice(0, 13)])).digest('hex');
  const useCache = !options.fetcher && !options.now && !options.bypassCache;
  const previous = cache.get(key);
  if (useCache && previous && previous.expires > Date.now()) return previous.value;
  const value = (async (): Promise<GoogleAdsReport> => {
    try {
      const data = await fetchGoogleAds(c as GoogleAdsConfig, period, { fetcher: options.fetcher, now, includeDetails: true });
      return { ...base, status: 'connected', detail: 'Consulta à API confirmada. Dados da conta e do escopo configurados.', data };
    } catch (error) {
      const code = error instanceof GoogleAdsError ? error.code : 'api_unavailable';
      return { ...base, status: 'error', error_code: code,
        detail: messages[code] ?? 'A consulta ao Google Ads não foi concluída. Nenhum valor parcial será exibido.' };
    }
  })();
  if (useCache) {
    cache.set(key, { expires: Date.now() + 5 * 60_000, value });
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    void value.then(result => {
      const entry = cache.get(key);
      if (result.status === 'error' && entry?.value === value) entry.expires = Date.now() + 30_000;
    });
  }
  return value;
}
