import { constants, createPrivateKey, sign } from 'node:crypto';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const scopes = { ads: 'https://www.googleapis.com/auth/adwords', conversions: 'https://www.googleapis.com/auth/datamanager' };
const encode = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** OAuth JWT Bearer oficial. Nunca usa URLs ou delegação de usuário vindas do JSON. */
export function googleServiceAccountTokenBody(json: string, now = Date.now(), purpose: keyof typeof scopes = 'ads'): URLSearchParams {
  try {
    if (json.length > 65_536 || !Object.hasOwn(scopes, purpose)) throw new Error();
    const key: unknown = JSON.parse(json);
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw new Error();
    const credential = key as Record<string, unknown>;
    const email = credential.client_email;
    const privateKey = credential.private_key;
    const keyId = credential.private_key_id;
    if (credential.type !== 'service_account'
      || typeof email !== 'string' || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)
      || typeof privateKey !== 'string' || !privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
      || typeof keyId !== 'string' || !/^[a-f0-9]{40}$/.test(keyId)
      || !Number.isFinite(now) || now < 0) throw new Error();

    const signingKey = createPrivateKey(privateKey);
    if (signingKey.asymmetricKeyType !== 'rsa'
      || (signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    const issued = Math.floor(now / 1000);
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: keyId });
    const claims = encode({ iss: email, scope: scopes[purpose], aud: GOOGLE_TOKEN_URL,
      iat: issued, exp: issued + 3600 });
    const content = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(content, 'utf8'), {
      key: signingKey, padding: constants.RSA_PKCS1_PADDING,
    }).toString('base64url');
    return new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${content}.${signature}` });
  } catch {
    // Exceções do parser/OpenSSL podem conter partes da credencial; não as propagar.
    throw new Error('invalid_service_account');
  }
}
