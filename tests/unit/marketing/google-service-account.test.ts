import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { googleServiceAccountTokenBody } from '../../../src/marketing/google-service-account.js';
import { googleAdsReader, type GoogleAdsConfig } from '../../../src/marketing/google-ads-client.js';
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', GOOGLE_ADS_ENABLED: false } }));
import { getGoogleAdsReport } from '../../../src/marketing/google-ads-report.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credential = {
  type: 'service_account', client_email: 'farejador-google-ads@test-project.iam.gserviceaccount.com',
  private_key_id: 'a'.repeat(40),
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  // Campos externos não devem controlar endpoint, escopo ou delegação.
  token_uri: 'https://untrusted.example/token', subject: 'other@example.com',
};
const config: GoogleAdsConfig = { environment: 'test', customerId: '1234567890', apiVersion: 'v25',
  scope: 'account', campaignIds: [], serviceAccountJson: JSON.stringify(credential) };

describe('Conta de serviço Google — assinatura e isolamento das credenciais', () => {
  it('gera JWT RS256 verificável, válido por uma hora e restrito ao Google Ads', () => {
    const body = googleServiceAccountTokenBody(JSON.stringify(credential), 1790812800000);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = body.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: credential.private_key_id });
    expect(claims).toEqual({ iss: credential.client_email, scope: 'https://www.googleapis.com/auth/adwords',
      aud: 'https://oauth2.googleapis.com/token', iat: 1790812800, exp: 1790816400 });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), rsa.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(claims).not.toHaveProperty('sub');
    expect(body.toString()).not.toContain('PRIVATE KEY');
  });

  it('autentica sem cliente OAuth humano e usa somente o endpoint fixo do Google', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'test-access' }))
      .mockResolvedValueOnce(Response.json({ results: [{ id: '1' }] }));
    const reader = await googleAdsReader(config, request);
    expect(await reader('SELECT customer.id FROM customer')).toEqual([{ id: '1' }]);
    expect(request.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    const body = request.mock.calls[0][1].body as URLSearchParams;
    expect(body.has('assertion')).toBe(true);
    expect(body.has('client_secret')).toBe(false);
    expect(request.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer test-access' });
  });

  it.each([
    '{incomplete-json', JSON.stringify({ ...credential, type: 'authorized_user' }),
    JSON.stringify({ ...credential, client_email: 'not-a-service-account@example.com' }),
    JSON.stringify({ ...credential, private_key: 'sensitive-invalid-key' }),
    JSON.stringify({ ...credential, private_key_id: 'not-an-id' }), ' '.repeat(65_537),
  ])('falha antes de enviar credenciais inválidas e não revela o erro original', async json => {
    const request = vi.fn();
    await expect(googleAdsReader({ ...config, serviceAccountJson: json }, request)).rejects.toThrow('invalid_service_account');
    expect(request).not.toHaveBeenCalled();
    expect(() => googleServiceAccountTokenBody(json)).toThrow(/^invalid_service_account$/);
  });

  it('rejeita chaves EC e não retorna ao OAuth antigo quando o JSON é inválido', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const json = JSON.stringify({ ...credential, private_key: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
    const request = vi.fn();
    await expect(googleAdsReader({ ...config, serviceAccountJson: json,
      clientId: 'old', clientSecret: 'old-secret', refreshToken: 'old-refresh' }, request)).rejects.toThrow('invalid_service_account');
    expect(request).not.toHaveBeenCalled();
  });

  it('relatório pede o JSON completo quando falta autenticação e nunca expõe a chave', async () => {
    const missing = await getGoogleAdsReport('7d', { settings: { enabled: true, config: { ...config, serviceAccountJson: undefined } } });
    expect(missing.missing).toEqual(['GOOGLE_ADS_SERVICE_ACCOUNT_JSON']);
    const invalid = await getGoogleAdsReport('7d', { settings: { enabled: true, config: { ...config, serviceAccountJson: 'sensitive-invalid-key' } }, fetcher: vi.fn() });
    expect(invalid.error_code).toBe('invalid_service_account');
    expect(invalid.detail).toContain('não apenas o ID da chave');
    expect(JSON.stringify(invalid)).not.toMatch(/sensitive-invalid-key|PRIVATE KEY/);
  });
});
