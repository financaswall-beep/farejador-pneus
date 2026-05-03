/**
 * Verifica se o Atendente Shadow já trabalhou.
 * Apenas SELECT. Nao altera nada no banco.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente. Rode com: npx tsx --env-file=.env scripts/verificar-atendente.ts');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  console.log('=== VERIFICANDO ATIVIDADE DO ATENDENTE ===\n');

  // 1. Descobre as colunas existentes
  const columns = await client.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'ops' AND table_name = 'atendente_jobs'
    ORDER BY ordinal_position;
  `);

  console.log('Colunas na tabela ops.atendente_jobs:');
  const colNames = columns.rows.map((r) => r.column_name);
  console.log('  ' + colNames.join(', '));
  console.log('');

  // 2. Conta total de jobs
  const totalJobs = await client.query('SELECT COUNT(*) as total FROM ops.atendente_jobs;');
  console.log(`Total de jobs: ${totalJobs.rows[0].total}`);

  // 3. Conta por status
  const byStatus = await client.query(`
    SELECT status, COUNT(*) as count 
    FROM ops.atendente_jobs 
    GROUP BY status 
    ORDER BY count DESC;
  `);

  console.log('\nJobs por status:');
  for (const row of byStatus.rows) {
    console.log(`  ${row.status}: ${row.count}`);
  }

  // 4. Ultimos 5 jobs
  const recentJobs = await client.query(`
    SELECT * FROM ops.atendente_jobs
    ORDER BY created_at DESC
    LIMIT 5;
  `);

  console.log('\nUltimos 5 jobs:');
  for (const row of recentJobs.rows) {
    console.log(`  ID: ${row.id} | Status: ${row.status} | Conversa: ${row.conversation_id}`);
    if (row.created_at) console.log(`    Criado: ${row.created_at}`);
    if (row.processed_at) console.log(`    Processado: ${row.processed_at}`);
    if (row.error_message) console.log(`    Erro: ${row.error_message.substring(0, 150)}`);
    console.log('');
  }

  // 5. Jobs processados com sucesso
  const processedJobs = await client.query(`
    SELECT * FROM ops.atendente_jobs
    WHERE status = 'processed'
    ORDER BY created_at DESC
    LIMIT 5;
  `);

  if (processedJobs.rows.length > 0) {
    console.log('Jobs processados com sucesso:');
    for (const row of processedJobs.rows) {
      console.log(`  Conversa #${row.conversation_id} | Status: ${row.status}`);
      if (row.processed_at) console.log(`    Processado em: ${row.processed_at}`);
      if (row.error_message) console.log(`    Erro: ${row.error_message.substring(0, 100)}`);
    }
  }

  // 6. Mensagens recentes
  const recentMessages = await client.query(`
    SELECT COUNT(*) as total 
    FROM raw.raw_events 
    WHERE event_type = 'message_created' 
    AND created_at > NOW() - INTERVAL '24 hours';
  `);

  console.log(`\nMensagens recebidas nas ultimas 24h: ${recentMessages.rows[0].total}`);

  await client.end();
  console.log('\n=== FIM DA VERIFICACAO ===');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
