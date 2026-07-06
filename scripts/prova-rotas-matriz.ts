/**
 * PROVA DE PARIDADE DE ROTAS — painel da matriz (obra 300, route.ts).
 *
 * O QUE PROVA: a lista completa [método + endereço] que registerPainelRoute
 * registra no Fastify. Se a refatoração derrubar/renomear/duplicar UMA rota
 * que seja, esta prova REPROVA. (Duplicata nem chega aqui: o Fastify estoura
 * FST_ERR_DUPLICATED_ROUTE no registro — a prova captura e reprova também.)
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-rotas-matriz.ts                    -> compara com o baseline
 *   npx tsx --env-file=.env.pooler scripts/prova-rotas-matriz.ts --gravar-baseline  -> (re)grava o baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { registerPainelRoute } from '../src/admin/painel/route.js';

const BASELINE = path.join(process.cwd(), 'scripts', 'baseline-rotas-matriz.json');
const gravar = process.argv.includes('--gravar-baseline');

async function main() {
  const rotas: string[] = [];
  const app = Fastify({ logger: false });
  app.addHook('onRoute', (r) => {
    const metodos = Array.isArray(r.method) ? r.method : [r.method];
    // Cadeado no manifesto (recomendação da banca de segurança 07-05): rota que
    // PERDER o preHandler numa refatoração futura reprova aqui sozinha —
    // método+URL iguais não bastam, o guard faz parte do contrato.
    const guards = r.preHandler ? (Array.isArray(r.preHandler) ? r.preHandler.length : 1) : 0;
    const cadeado = guards > 0 ? `AUTH(${guards})` : 'PUBLICA';
    for (const m of metodos) {
      if (m === 'HEAD') continue; // Fastify cria HEAD sozinho pra todo GET — ruído, não contrato
      rotas.push(`${m} ${r.url} ${cadeado}`);
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
