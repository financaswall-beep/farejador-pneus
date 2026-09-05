// Extrai o bearer cru para distinguir sessão de token de acesso em
// set-credentials/logout. A autenticação continua sob responsabilidade de auth.ts.
export function bearerFrom(request: { headers: Record<string, unknown> }): string {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = request.headers['x-partner-token'];
  return typeof x === 'string' ? x.trim() : '';
}
