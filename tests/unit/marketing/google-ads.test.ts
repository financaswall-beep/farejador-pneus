import { describe, expect, it, vi } from 'vitest';
import { fetchGoogleAds } from '../../../src/marketing/google-ads.js';
import type { GoogleAdsConfig } from '../../../src/marketing/google-ads-client.js';
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', GOOGLE_ADS_ENABLED: false } }));
import { getGoogleAdsReport } from '../../../src/marketing/google-ads-report.js';
import { googleAdsEnvShape } from '../../../src/shared/config/env-google-ads.js';
import { z } from 'zod';

const config: GoogleAdsConfig = { environment: 'test', customerId: '1234567890', loginCustomerId: '0987654321',
  clientId: 'test-client', clientSecret: 'private-secret', refreshToken: 'private-refresh',
  apiVersion: 'v25', scope: 'campaigns', campaignIds: ['11', '22'] };
const now = new Date('2026-10-01T01:00:00Z'); // Ainda 30/09 no fuso da conta.
const customer = { id: config.customerId, descriptiveName: '2W Pneus', currencyCode: 'BRL',
  timeZone: 'America/Sao_Paulo', manager: false, testAccount: true };
const row = (id = '11', date = '2026-09-30', cost = '10000000') => ({
  campaign: { id, name: `Pneu ${id}`, status: 'REMOVED', advertisingChannelType: 'SEARCH' },
  segments: { date }, metrics: { costMicros: cost, impressions: '100', clicks: '10', conversions: 1.5 },
});
function fetcher(pages: object[] = [{}], account = customer) {
  const bodies = [{ access_token: 'private-access' }, { results: [{ customer: account }] }, ...pages];
  return vi.fn(async () => Response.json(bodies.shift()));
}

describe('Google Ads — leitura isolada e métricas reais', () => {
  it('renova OAuth, pagina, filtra por IDs e usa datas do fuso da conta', async () => {
    const request = fetcher([{ results: [row('11', '2026-09-29', '1234555')], nextPageToken: 'next' },
      { results: [row('11', '2026-09-30', '2344555'), row('22')] }]);
    const result = await fetchGoogleAds(config, '7d', { fetcher: request as typeof fetch, now });
    expect(result.period).toEqual({ since: '2026-09-24', until: '2026-09-30' });
    expect(result.totals).toEqual({ investment: 13.58, impressions: 300, clicks: 30, conversions: 4.5, ctr: 10, cpc: 0.45 });
    expect(result.campaigns.find(c => c.id === '11')).toMatchObject({ investment: 3.58, status: 'REMOVED', delivery_days: 2 });
    const calls = request.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(String(calls[0][1].body)).toContain('grant_type=refresh_token');
    expect(calls[2][0]).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
    expect(calls[2][1].headers).toMatchObject({ Authorization: 'Bearer private-access', 'login-customer-id': '0987654321' });
    expect(calls[2][1].headers).not.toHaveProperty('developer-token');
    expect(JSON.parse(String(calls[2][1].body)).query).toContain('campaign.id IN (11,22)');
    expect(JSON.parse(String(calls[3][1].body)).pageToken).toBe('next');
    expect(JSON.stringify(result)).not.toMatch(/private|refreshToken|clientSecret|attributed_sales/);
  });
  it('soma micros antes de arredondar e aceita relatório vazio sem inventar vendas', async () => {
    const result = await fetchGoogleAds(config, '30d', { now, fetcher: fetcher([
      { results: [row('11', '2026-09-29', '4000'), row('11', '2026-09-30', '4000')] },
    ]) as typeof fetch });
    expect(result.totals.investment).toBe(0.01);
    const empty = await fetchGoogleAds(config, '30d', { now, fetcher: fetcher() as typeof fetch });
    expect(empty.campaigns).toEqual([]); expect(empty.totals.cpc).toBeNull();
  });
  it.each([
    [{ ...customer, manager: true }, 'manager_account'],
    [{ ...customer, testAccount: false }, 'environment_mismatch'],
    [{ ...customer, currencyCode: 'USD' }, 'unsupported_currency'],
    [{ ...customer, id: '9999999999' }, 'invalid_account'],
  ])('recusa conta incorreta antes de consultar métricas: %j', async (account, code) => {
    const request = fetcher([], account);
    await expect(fetchGoogleAds(config, '7d', { fetcher: request as typeof fetch, now })).rejects.toThrow(code);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ results: [row('999')] }],
    [{ results: [row(), row()] }],
    [{ results: [row('11', '2026-01-01')] }],
  ])('recusa resposta fora do escopo, duplicada ou fora do período', async (page) => {
    await expect(fetchGoogleAds(config, '7d', { now, fetcher: fetcher([page]) as typeof fetch })).rejects.toThrow('invalid_response');
  });
  it('não retorna totais parciais se a paginação falhar ou repetir um cursor', async () => {
    const request = fetcher([{ results: [row()], nextPageToken: 'same' }, { nextPageToken: 'same' }]);
    await expect(fetchGoogleAds(config, '7d', { now, fetcher: request as typeof fetch })).rejects.toThrow('invalid_pagination');
  });
  it('não faz chamadas sem escopo e não admite injeção na consulta', async () => {
    const request = vi.fn();
    for (const bad of [{ ...config, scope: undefined }, { ...config, campaignIds: ["11) OR true"] }]) {
      await expect(fetchGoogleAds(bad as GoogleAdsConfig, '7d', { fetcher: request, now })).rejects.toThrow('invalid_config');
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('informa configuração ausente sem presumir conexão e sem retornar segredos', async () => {
    const request = vi.fn();
    const result = await getGoogleAdsReport('7d', { settings: { enabled: true, config: { ...config, scope: undefined } }, fetcher: request, now });
    expect(result.status).toBe('not_configured'); expect(result.missing).toEqual(['GOOGLE_ADS_SCOPE']);
    expect(result.data).toBeNull(); expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('explica aprovação pendente do Cloud sem expor a mensagem externa', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'private-access' }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'sensitive', details: [{ errors: [
        { errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'sensitive' },
      ] }] } }, { status: 403 }));
    const result = await getGoogleAdsReport('7d', { settings: { enabled: true, config }, fetcher: request, now });
    expect(result.status).toBe('error'); expect(result.error_code).toBe('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION');
    expect(result.data).toBeNull(); expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('distingue autorização revogada e indisponibilidade, sempre sem segredos', async () => {
    for (const [request, code] of [
      [vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant', error_description: 'private' }, { status: 400 })), 'authorization_expired'],
      [vi.fn().mockRejectedValue(Error('private')), 'api_unavailable'],
    ] as const) {
      const result = await getGoogleAdsReport('7d', { settings: { enabled: true, config }, fetcher: request, now });
      expect(result.error_code).toBe(code); expect(result.data).toBeNull(); expect(JSON.stringify(result)).not.toContain('private');
    }
  });
  it('aceita IDs com hífens e variáveis vazias do Compose; desliga por padrão', () => {
    const schema = z.object(googleAdsEnvShape);
    expect(schema.parse({ GOOGLE_ADS_CLIENT_ID: '', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890' })).toMatchObject({
      GOOGLE_ADS_ENABLED: false, GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CLIENT_ID: undefined,
    });
    expect(schema.safeParse({ GOOGLE_ADS_CAMPAIGN_IDS: '11 OR 1' }).success).toBe(false);
  });
});
