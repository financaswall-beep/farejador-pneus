/**
 * PROVA da CHAVE DA REDE (0165) — "Recebe pedidos da Rede?" — no env `test`.
 *
 * Chama o CÓDIGO REAL do motor sobre a rede fake geo-*. Tudo dentro de
 * BEGIN/ROLLBACK: não persiste NADA — nem o estoque que ela mesma monta, nem a
 * escrita da chave (que roda por um proxy traduzindo BEGIN/COMMIT em SAVEPOINT).
 *
 * AUTO-SUFICIENTE de propósito: o seed `seed-fake-rede-test.cjs` está defasado
 * (grava estoque sem product_id/tire_condition e hoje nem roda — FK de
 * partner_sessions), então a prova REPARA o estoque das lojas fake dentro da
 * própria transação. Assim ela não mente por falta de cenário nem depende de
 * conserto de seed, que é obra à parte.
 *
 * O que crava:
 *   R1  baseline: com TODAS ligadas, um PARCEIRO ganha a retirada (quem for)
 *   R2  desligando o vencedor, ele NUNCA mais é escolhido na retirada
 *   R3  a desligada some do pool por PROXIMIDADE
 *   R4  a desligada some do pool por CIDADE (plano B)
 *   R5  a desligada some da ENTREGA
 *   R6  a desligada não é indicada em localizacao_loja (os 2 caminhos)
 *   R7  a ÚNICA loja com o pneu está desligada → matriz/honestidade, JAMAIS ela
 *   R8  EXIBIR não filtra: getUnitDisplayById da desligada ainda devolve a loja
 *   R9  escrita: desliga (changed), repete (idempotente), audita, 404
 *   R10 guarda de código: o gancho de calor do agent.ts carrega o filtro
 *   R11 religou → volta a concorrer na hora (reversão sem deploy)
 *
 * USO: npx tsx --env-file=.env.pooler scripts/prova-chave-rede-test.ts
 */
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../src/persistence/db.js';
import {
  decideStoreForItemsGeo,
  getUnitDisplayById,
  getUnitMapsUrl,
  resolveUnitCandidates,
  resolveUnitCandidatesByProximity,
} from '../src/atendente-v2/fulfillment.js';
import { setPartnerUnitNetworkOrders } from '../src/admin/painel/queries-parceiros-rede.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };
const SLUGS = ['geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai', 'geo-bairro'];

/**
 * Faz o writer (que abre a PRÓPRIA transação) caber dentro da transação da prova:
 * BEGIN→SAVEPOINT, COMMIT→RELEASE, ROLLBACK→ROLLBACK TO. Nada escapa do ROLLBACK.
 */
function savepointPool(client: PoolClient, name: string): Pool {
  let seq = 0;
  return {
    // Nome ÚNICO por chamada: com nome repetido, o ROLLBACK TO de uma chamada
    // posterior pode desfazer o que a anterior gravou (foi o que derrubou a R11).
    connect: async () => {
      const sp = `${name}_${++seq}`;
      return {
        query: (text: unknown, params?: unknown) => {
          if (typeof text === 'string') {
            const sql = text.trim().toUpperCase();
            if (sql === 'BEGIN') return client.query(`SAVEPOINT ${sp}`);
            if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${sp}`);
            if (sql === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          }
          return client.query(text as string, params as unknown[]);
        },
        release: () => undefined,
      };
    },
  } as unknown as Pool;
}

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA CHAVE DA REDE 0165 (test) ===');
  if (env.ROUTING_GEO_ROAD_DISTANCE) {
    console.log('⚠️  ROUTING_GEO_ROAD_DISTANCE on — a prova espera haversine; desligue p/ determinismo.');
  }

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const ids = await client.query<{ slug: string; unit_id: string; id: string }>(
      `SELECT slug, unit_id, id FROM network.partner_units WHERE environment=$1 AND slug = ANY($2)`,
      [ENV, SLUGS],
    );
    if (ids.rowCount !== SLUGS.length) {
      throw new Error(`esperava ${SLUGS.length} geo-fake, achei ${ids.rowCount}.`);
    }
    const U: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.unit_id]));
    const PU: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.id]));
    const slugOf = (unitId: string): string => Object.keys(U).find((s) => U[s] === unitId) ?? unitId.slice(0, 8);
    const puIdOf = (slug: string): string => PU[slug]!;

    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    // Cenário: TODA loja fake com o pneu fake em estoque (dentro da transação).
    const prepararEstoque = () => client.query(
      `UPDATE commerce.partner_stock_levels
          SET product_id=$3, tire_condition='meia_vida', quantity_on_hand=10, quantity_reserved=0,
              stock_status='in_stock', is_tracked=true, deleted_at=NULL,
              sale_price=COALESCE(sale_price, 350)
        WHERE environment=$1 AND unit_id = ANY($2)`,
      [ENV, SLUGS.map((s) => U[s]!), productId],
    );
    const decide = (modalidade: 'delivery' | 'pickup') =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI, items, modalidade, customerLocation: COPA,
        clientNeighborhoodCanonical: 'copacabana',
      });
    const desliga = (...slugs: string[]) => client.query(
      `UPDATE network.partner_units SET accepts_network_orders=false WHERE environment=$1 AND slug = ANY($2)`,
      [ENV, slugs],
    );
    const zera = (...slugs: string[]) => client.query(
      `UPDATE commerce.partner_stock_levels SET quantity_on_hand=0, stock_status='out_of_stock'
        WHERE environment=$1 AND unit_id = ANY($2)`,
      [ENV, slugs.map((s) => U[s]!)],
    );

    // ── R1 + R2 + R3 + R4 + R5: o vencedor real sai do jogo ────────────────────
    await client.query('BEGIN');
    await prepararEstoque();
    const base = await decide('pickup');
    check('R1 baseline (todas ligadas): a retirada cai num PARCEIRO',
      base.kind === 'partner', base.kind === 'partner' ? slugOf(base.routing.unitId) : base.kind);
    if (base.kind !== 'partner') throw new Error('sem baseline de parceiro — cenário não montou');
    const vencedor = slugOf(base.routing.unitId);

    await desliga(vencedor);
    const r2 = await decide('pickup');
    check(`R2 retirada NUNCA cai na desligada (${vencedor})`,
      r2.kind !== 'partner' || slugOf(r2.routing.unitId) !== vencedor,
      r2.kind === 'partner' ? `foi pra ${slugOf(r2.routing.unitId)}` : r2.kind);

    const porProx = await resolveUnitCandidatesByProximity(client, ENV);
    check('R3 some do pool por PROXIMIDADE',
      !porProx.some((c) => c.ctx.unitId === U[vencedor]), `${porProx.length} candidatos`);

    const porCidade = await resolveUnitCandidates(client, ENV, GEO_MUNI);
    check('R4 some do pool por CIDADE (plano B)',
      !porCidade.some((c) => c.ctx.unitId === U[vencedor]), `${porCidade.length} candidatos`);

    const r5 = await decide('delivery');
    check('R5 entrega NUNCA cai na desligada',
      r5.kind !== 'partner' || slugOf(r5.routing.unitId) !== vencedor,
      r5.kind === 'partner' ? `foi pra ${slugOf(r5.routing.unitId)}` : r5.kind);
    await client.query('ROLLBACK');

    // ── R6 localizacao_loja: os 2 caminhos de getUnitMapsUrl ───────────────────
    await client.query('BEGIN');
    await prepararEstoque();
    await desliga(...SLUGS);
    const mapsMuni = await getUnitMapsUrl(client, ENV, { municipio: GEO_MUNI, customerLocation: COPA });
    check('R6a caminho por município não indica loja desligada',
      mapsMuni === null, String(mapsMuni?.nome_loja ?? 'null'));
    const mapsFallback = await getUnitMapsUrl(client, ENV, { municipio: null, bairro: null });
    check('R6b fallback mono-loja não indica loja desligada',
      mapsFallback === null, String(mapsFallback?.nome_loja ?? 'null'));
    await client.query('ROLLBACK');

    // ── R7 a ÚNICA com o pneu está desligada → nunca vaza pra ela ──────────────
    await client.query('BEGIN');
    await prepararEstoque();
    const sozinha = 'geo-leme';
    await zera(...SLUGS.filter((s) => s !== sozinha));
    await desliga(sozinha);
    const r7p = await decide('pickup');
    check('R7a retirada: única com estoque desligada → matriz/honestidade, jamais ela',
      r7p.kind !== 'partner', r7p.kind);
    const r7d = await decide('delivery');
    check('R7b entrega: idem', r7d.kind !== 'partner', r7d.kind);

    // ── R8 EXIBIR não filtra (pedido antigo não vira órfão) ────────────────────
    const display = await getUnitDisplayById(client, ENV, U[sozinha]!);
    check('R8 getUnitDisplayById ainda mostra a loja desligada (histórico intacto)',
      display !== null && typeof display.nome_loja === 'string', String(display?.nome_loja ?? 'null'));
    await client.query('ROLLBACK');

    // ── R9 escrita: idempotente, auditada, 404 · R11 reversão ──────────────────
    await client.query('BEGIN');
    await prepararEstoque();
    const spPool = savepointPool(client, 'sp_chave');
    const alvo = puIdOf(sozinha);
    const off = await setPartnerUnitNetworkOrders(ENV, alvo, false, 'prova', spPool);
    check('R9a desligar grava e marca changed', off.updated === true && off.changed === true, JSON.stringify(off));
    const again = await setPartnerUnitNetworkOrders(ENV, alvo, false, 'prova', spPool);
    check('R9b repetir o mesmo valor é seguro e NÃO é mudança',
      again.updated === true && again.changed === false, JSON.stringify(again));
    const trilha = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.events
        WHERE environment=$1 AND event_type='partner_network_orders_updated' AND entity_id=$2`,
      [ENV, alvo],
    );
    check('R9c uma linha de auditoria (só a mudança real)', trilha.rows[0]!.n === '1', `${trilha.rows[0]!.n} linha(s)`);
    const gravou = await client.query<{ v: boolean }>(
      `SELECT accepts_network_orders AS v FROM network.partner_units WHERE environment=$1 AND id=$2`,
      [ENV, alvo],
    );
    check('R9d o banco ficou com a chave desligada', gravou.rows[0]!.v === false, String(gravou.rows[0]!.v));
    const naoExiste = await setPartnerUnitNetworkOrders(ENV, '00000000-0000-0000-0000-000000000000', false, 'prova', spPool);
    check('R9e unidade inexistente = not_found',
      naoExiste.updated === false && naoExiste.reason === 'not_found', JSON.stringify(naoExiste));

    // Só ela desligada: o pool tem que ter TODAS menos ela.
    const poolSemEla = await resolveUnitCandidatesByProximity(client, ENV);
    check('R9f com só ela desligada, as outras continuam no pool',
      !poolSemEla.some((c) => c.ctx.unitId === U[sozinha]) && poolSemEla.length > 0, `${poolSemEla.length} candidatos`);

    const on = await setPartnerUnitNetworkOrders(ENV, alvo, true, 'prova', spPool);
    const voltou = await resolveUnitCandidatesByProximity(client, ENV);
    check('R11 religou pela Matriz → volta pro pool na hora (reversão sem deploy)',
      on.changed === true && voltou.some((c) => c.ctx.unitId === U[sozinha]),
      `${JSON.stringify(on)} · ${voltou.length} candidatos`);
    await client.query('ROLLBACK');

    // ── R10 guarda de código (caminho não exportado do agent.ts) ───────────────
    const agentSrc = readFileSync(new URL('../src/atendente-v2/agent.ts', import.meta.url), 'utf8');
    const at = agentSrc.indexOf('async function nearestStoreKm');
    check('R10 gancho de calor (agent.ts nearestStoreKm) carrega o filtro',
      at >= 0 && agentSrc.slice(at, at + 900).includes('accepts_network_orders'));

    // ── Estado final: nada ficou desligado por causa da prova ──────────────────
    const sujeira = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM network.partner_units WHERE environment=$1 AND accepts_network_orders=false`,
      [ENV],
    );
    check('LIMPEZA: nenhuma unidade ficou desligada depois do ROLLBACK',
      sujeira.rows[0]!.n === '0', `${sujeira.rows[0]!.n} desligada(s)`);

    console.log(fails === 0 ? '\n✅ TUDO VERDE' : `\n❌ ${fails} FALHA(S)`);
    process.exitCode = fails === 0 ? 0 : 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
