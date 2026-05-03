/**
 * Monitor da LLM Atendente — verifica se esta processando agora.
 * Apenas SELECT. Nao altera nada no banco.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente. Rode com: npx tsx --env-file=.env scripts/monitor-llm-atendente.ts');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  console.log('=== MONITOR DA LLM ATENDENTE ===\n');

  // 1. Jobs sendo processados AGORA (locked e nao finalizado)
  const processingNow = await client.query(`
    SELECT 
      id,
      conversation_id,
      locked_by,
      locked_at,
      EXTRACT(EPOCH FROM (NOW() - locked_at)) as segundos_processando
    FROM ops.atendente_jobs
    WHERE locked_at IS NOT NULL 
      AND processed_at IS NULL
      AND status = 'pending'
    ORDER BY locked_at DESC;
  `);

  if (processingNow.rows.length > 0) {
    console.log(`🔥 PROCESSANDO AGORA: ${processingNow.rows.length} job(s)\n`);
    for (const row of processingNow.rows) {
      console.log(`  Conversa: ${row.conversation_id}`);
      console.log(`  Worker: ${row.locked_by}`);
      console.log(`  Processando ha: ${Math.round(row.segundos_processando)}s\n`);
    }
  } else {
    console.log('⏳ Nenhum job sendo processado no momento.\n');
  }

  // 2. Worker mais recente (ver se esta vivo)
  const lastWorker = await client.query(`
    SELECT 
      locked_by,
      MAX(locked_at) as ultimo_heartbeat,
      EXTRACT(EPOCH FROM (NOW() - MAX(locked_at))) as segundos_desde_ultimo
    FROM ops.atendente_jobs
    WHERE locked_at IS NOT NULL
    GROUP BY locked_by
    ORDER BY ultimo_heartbeat DESC
    LIMIT 1;
  `);

  if (lastWorker.rows.length > 0) {
    const w = lastWorker.rows[0];
    const segundos = Math.round(w.segundos_desde_ultimo);
    const status = segundos < 60 ? '🟢 ONLINE' : segundos < 300 ? '🟡 INATIVO' : '🔴 OFFLINE';

    console.log('Status do Worker:');
    console.log(`  ID: ${w.locked_by}`);
    console.log(`  Ultimo ping: ${segundos}s atras`);
    console.log(`  Status: ${status}\n`);
  } else {
    console.log('Nenhum worker registrou atividade ainda.\n');
  }

  // 3. Jobs processados nos ultimos 5 minutos
  const recentProcessed = await client.query(`
    SELECT COUNT(*) as total
    FROM ops.atendente_jobs
    WHERE processed_at > NOW() - INTERVAL '5 minutes';
  `);

  console.log(`Jobs processados nos ultimos 5 minutos: ${recentProcessed.rows[0].total}`);

  // 4. Jobs processados nas ultimas 24h
  const dailyProcessed = await client.query(`
    SELECT COUNT(*) as total
    FROM ops.atendente_jobs
    WHERE processed_at > NOW() - INTERVAL '24 hours';
  `);

  console.log(`Jobs processados nas ultimas 24h: ${dailyProcessed.rows[0].total}`);

  // 5. Proximo job na fila
  const nextJob = await client.query(`
    SELECT 
      id,
      conversation_id,
      created_at,
      EXTRACT(EPOCH FROM (NOW() - created_at)) as segundos_na_fila
    FROM ops.atendente_jobs
    WHERE status = 'pending' AND locked_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1;
  `);

  if (nextJob.rows.length > 0) {
    const j = nextJob.rows[0];
    console.log(`\nProximo job na fila: Conversa ${j.conversation_id}`);
    console.log(`Na fila ha: ${Math.round(j.segundos_na_fila)}s`);
  } else {
    console.log('\nNenhum job aguardando na fila.');
  }

  await client.end();
  console.log('\n=== FIM DO MONITOR ===');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
