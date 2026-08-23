/**
 * PROVA DE PARIDADE DE ROTAS — painel da matriz (obra 300, route.ts).
 *
 * O QUE PROVA: a lista completa [método + endereço + guarda exato] que
 * registerPainelRoute registra no Fastify. Se uma refatoração derrubar,
 * renomear, duplicar ou afrouxar UMA rota de owner para admin, esta prova
 * REPROVA. (Duplicata nem chega aqui: o Fastify estoura
 * FST_ERR_DUPLICATED_ROUTE no registro — a prova captura e reprova também.)
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-rotas-matriz.ts                    -> compara com o baseline
 *   npx tsx --env-file=.env.pooler scripts/prova-rotas-matriz.ts --gravar-baseline  -> (re)grava o baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type RouteOptions } from 'fastify';

Object.assign(process.env, {
  NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
  CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
});

const BASELINE = path.join(process.cwd(), 'scripts', 'baseline-rotas-matriz.json');
const gravar = process.argv.includes('--gravar-baseline');

function contratoDeAcesso(route: RouteOptions): string {
  const handlers = route.preHandler
    ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler])
    : [];
  const guardas = handlers.map((handler) => handler.name || 'ANONIMO');

  if (route.url.startsWith('/admin/api/')) {
    if (guardas.length !== 1) {
      throw new Error(`${route.method} ${route.url}: API admin precisa de exatamente um guarda`);
    }
    if (guardas[0] === 'requireAdminOwner') {
      return 'GUARD(requireAdminOwner) SESSION(ms_) ROLE(owner) POOL(admin) SCOPE(matriz)';
    }
    if (guardas[0] === 'requireAdminAuth') {
      return 'GUARD(requireAdminAuth) SESSION(ms_) ROLE(owner|admin) POOL(admin) SCOPE(matriz)';
    }
    throw new Error(`${route.method} ${route.url}: guarda admin desconhecido (${guardas[0]})`);
  }

  if (guardas.length === 0) return 'PUBLICA';
  return `GUARD(${guardas.join('+')})`;
}

async function main() {
  const { registerPainelRoute } = await import('../src/admin/painel/route.js');
  const rotas: string[] = [];
  const app = Fastify({ logger: false });
  app.addHook('onRoute', (r) => {
    const metodos = Array.isArray(r.method) ? r.method : [r.method];
    const acesso = contratoDeAcesso(r);
    for (const m of metodos) {
      if (m === 'HEAD') continue; // Fastify cria HEAD sozinho pra todo GET — ruído, não contrato
      rotas.push(`${m} ${r.url} ${acesso}`);
    }
  });
  await registerPainelRoute(app);
  await app.ready();
  await app.close();
  rotas.sort();

  console.log(`[info] ${rotas.length} rotas registradas por registerPainelRoute`);

  if (gravar) {
    writeFileSync(BASELINE, JSON.stringify({ geradoEm: new Date().toISOString(), total: rotas.length, rotas }, null, 2) + '\n');
    console.log(`[OK] baseline gravado em scripts/baseline-rotas-matriz.json (${rotas.length} rotas)`);
    return;
  }
  if (!existsSync(BASELINE)) {
    console.error('[FALHA] baseline não existe. Gere com --gravar-baseline (só no passo 0!).');
    process.exit(1);
  }
  const antes: string[] = JSON.parse(readFileSync(BASELINE, 'utf8')).rotas;
  const sumiram = antes.filter((r) => !rotas.includes(r));
  const surgiram = rotas.filter((r) => !antes.includes(r));
  if (sumiram.length === 0 && surgiram.length === 0) {
    console.log(`[OK] PARIDADE DE ROTAS: idêntico ao baseline (${rotas.length} rotas).`);
    return;
  }
  for (const r of sumiram) console.error(`[FALHA] SUMIU:    ${r}`);
  for (const r of surgiram) console.error(`[FALHA] APARECEU: ${r}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[FALHA] prova de rotas não rodou: ${err.message}`);
  process.exit(1);
});
