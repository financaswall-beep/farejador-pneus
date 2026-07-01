/**
 * PROVA do FRETE DE ENTREGA PELO PINO (flag DELIVERY_FREIGHT_FROM_PIN) no env `test`,
 * chamando o CÓDIGO REAL do bot (executeTool → 'calcular_frete') com um PINO semeado e
 * SEM bairro digitado. Blinda o furo da conversa #696: a retirada saía do pino mas a
 * ENTREGA travava pedindo "rua, número e bairro" só pra COTAR o frete.
 *
 * DETERMINÍSTICO E SEM REDE: distância em LINHA RETA (haversine, ROUTING_GEO_ROAD_DISTANCE
 * off) e o reverse-geocode do pino é servido por um HIT semeado no commerce.geo_cache — a
 * chave "FAKE" só existe pra o cache ser consultado (geo-cache.ts só lê o cache com apiKey
 * truthy); o Google NUNCA é chamado. Tudo em BEGIN/ROLLBACK — não persiste nada.
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria os geo-* e o FAKE-REDE-PNEU).
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-frete-pino-test.ts
 */

// Flags LIGADAS antes de qualquer import que leia `env` (parse no 1º import).
process.env.ROUTING_GEO = 'true';
process.env.ROUTING_MATRIZ_AS_STORE = 'true';
process.env.WHOLESALE_UNIFIED_STOCK = 'true';
process.env.DELIVERY_FREIGHT_FROM_PIN = 'true';
process.env.GEO_CACHE = 'true';
process.env.ROUTING_GEO_ROAD_DISTANCE = 'false'; // haversine, sem Google
process.env.GOOGLE_MAPS_API_KEY = 'FAKE-CACHE-ONLY-DO-NOT-CALL';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };
const SLUGS = ['geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai', 'geo-bairro'];
const MEASURE = '90/90-18';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { executeTool, activeToolDefinitions } = await import('../src/atendente-v2/tools.js');
  const { reverseCacheKey } = await import('../src/shared/geo/geo-cache.js');
  const { MATRIZ_COORD } = await import('../src/atendente-v2/matriz-freight.js');
  const { haversineKm } = await import('../src/shared/geo/haversine.js');
  const { randomUUID } = await import('node:crypto');
  const { env } = await import('../src/shared/config/env.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.DELIVERY_FREIGHT_FROM_PIN || !env.ROUTING_GEO) throw new Error('ABORTADO: flags não ligaram.');
  if (env.ROUTING_GEO_ROAD_DISTANCE) console.log('⚠️  ROAD_DISTANCE on — a prova espera haversine.');
  console.log('=== PROVA FRETE PELO PINO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // Schema: com a flag on, calcular_frete NÃO exige mais bairro.
    const cf = activeToolDefinitions().find((t) => t.function.name === 'calcular_frete');
    const req = (cf?.function.parameters as { required?: string[] })?.required ?? ['bairro'];
    check('S0 schema: bairro deixou de ser obrigatório no calcular_frete (flag on)', req.length === 0, `required=[${req.join(',')}]`);

    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    if (!prod.rows[0]) throw new Error('FAKE-REDE-PNEU não existe. Rode scripts/seed-fake-rede-test.cjs.');
    const productId = prod.rows[0].id;
    const produtos = [{ product_id: productId, quantidade: 1 }];

    const matrizKm = Math.round(haversineKm(COPA, MATRIZ_COORD));
    console.log(`  (cliente COPA → matriz Petiti ≈ ${matrizKm} km, haversine)`);

    const seedMedida = () => client.query(`INSERT INTO commerce.tire_specs (environment, product_id, tire_size) VALUES ($1,$2,$3)`, [ENV, productId, MEASURE]);
    const seedGalpao = (qty: number) => client.query(`INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,$3,0)`, [ENV, MEASURE, qty]);
    const zeraParceiros = () => client.query(
      `UPDATE commerce.partner_stock_levels SET quantity_on_hand=0, stock_status='out_of_stock'
        WHERE environment=$1 AND unit_id IN (SELECT unit_id FROM network.partner_units WHERE environment=$1 AND slug = ANY($2))`,
      [ENV, SLUGS],
    );
    // Pino do cliente + HIT do reverse-geocode no cache (COPA → zona-sul-geo/copacabana).
    const seedPino = async (conversationId: string) => {
      await client.query(
        `INSERT INTO core.message_attachments (environment, chatwoot_attachment_id, message_id, conversation_id, file_type, coordinates_lat, coordinates_lng)
         VALUES ($1,$2,$3,$4,'location',$5,$6)`,
        [ENV, Math.floor(Math.random() * 1e15), randomUUID(), conversationId, COPA.lat, COPA.lng],
      );
      await client.query(
        `INSERT INTO commerce.geo_cache (cache_key, kind, value) VALUES ($1,'reverse',$2::jsonb)
         ON CONFLICT (cache_key) DO UPDATE SET value=EXCLUDED.value, created_at=now()`,
        [reverseCacheKey(COPA), JSON.stringify({ municipio: GEO_MUNI, neighborhood: 'copacabana' })],
      );
    };
    const cotar = (conversationId: string) => executeTool(client, ENV, conversationId, 'calcular_frete', { produtos });

    // ── P1 — MATRIZ: nenhum parceiro tem o pneu → entrega pela matriz, frete por distância ──
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    await zeraParceiros();
    const conv1 = randomUUID();
    await seedPino(conv1);
    const r1 = JSON.parse(await cotar(conv1));
    check('P1 pino sem bairro → frete cotado pela MATRIZ (via_pino, valor>0)',
      r1.disponivel === true && Number(r1.valor) > 0 && r1.via_pino === true,
      `disponivel=${r1.disponivel} valor=${r1.valor} via_pino=${r1.via_pino} motivo=${r1.motivo ?? '-'}`);
    check('P1b frete da matriz por distância (≈23 km → faixa R$ 13,00)', r1.valor === '13.00', `valor=${r1.valor}`);
    await client.query('ROLLBACK');

    // ── P2 — PARCEIRO: parceiro perto com estoque → frete fixo da rede (R$ 9,90) ──
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10); // matriz também tem, mas o parceiro perto vence a régua
    const conv2 = randomUUID();
    await seedPino(conv2);
    const r2 = JSON.parse(await cotar(conv2));
    check('P2 pino sem bairro → parceiro perto cota o frete fixo (R$ 9,90, via_pino)',
      r2.disponivel === true && r2.valor === '9.90' && r2.via_pino === true,
      `disponivel=${r2.disponivel} valor=${r2.valor} via_pino=${r2.via_pino}`);
    await client.query('ROLLBACK');

    // ── P3 — SEM pino → degrada elegante (pede a localização, NÃO quebra) ──
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    const r3 = JSON.parse(await cotar(randomUUID())); // conversa sem anexo de pino
    check('P3 sem pino → precisa_localizacao (degrada, não quebra nem cota errado)',
      r3.disponivel === false && r3.motivo === 'precisa_localizacao',
      `disponivel=${r3.disponivel} motivo=${r3.motivo}`);
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ TODAS AS PROVAS DO FRETE PELO PINO PASSARAM' : `❌ ${fails} PROVA(S) FALHARAM`}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
