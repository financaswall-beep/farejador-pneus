import {Client} from 'pg';

// Uso: npx tsx --env-file=<arquivo-local> scripts/auditar-cache-bot.ts prod 2026-10-25 2026-10-26
// Só metadados agregados; sem chamadas OpenAI, mensagens, nomes ou endereços.
const [environment,from,to]=process.argv.slice(2);
const validDate=(value:string|undefined)=>!!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
if(!['prod','test'].includes(environment??'') || !validDate(from) || !validDate(to) || from! > to!)
  throw new Error('Uso: auditar-cache-bot.ts <prod|test> <início YYYY-MM-DD> <fim YYYY-MM-DD>');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL ausente');
const client=new Client({connectionString:process.env.DATABASE_URL,
  ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false}});
try{
  await client.connect();await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const result=await client.query(`SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text dia,
      model,service_tier,pricing_version,
      CASE WHEN cached_tokens IS NULL THEN 'sem medição'
        WHEN cached_tokens>0 THEN 'com leitura de cache' ELSE 'sem leitura de cache' END cache,
      count(*)::int chamadas,count(*) FILTER(WHERE estimated_usd IS NULL)::int sem_preco,
      sum(input_tokens)::text entrada,sum(output_tokens)::text resposta,
      sum(cached_tokens)::text cache_lido,sum(cache_write_tokens)::text cache_gravado,
      round(100.0*sum(cached_tokens)/NULLIF(sum(input_tokens),0),2)::text percentual_entrada_reutilizada,
      CASE WHEN count(*) FILTER(WHERE estimated_usd IS NULL)>0 THEN NULL ELSE sum(estimated_usd) END::text estimado_usd,
      CASE WHEN count(*) FILTER(WHERE estimated_usd IS NULL)>0 THEN NULL ELSE avg(estimated_usd) END::text media_por_chamada_usd
    FROM ops.bot_model_usage WHERE environment=$1
      AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`,[environment,from,to]);
  await client.query('ROLLBACK');
  console.log(JSON.stringify({environment,from,to,timezone:'America/Sao_Paulo',currency:'USD',
    note:'Leitura de cache observada não comprova cache totalmente aquecido. Compare períodos e tarefas equivalentes; custo desconhecido permanece null.',
    rows:result.rows},null,2));
}catch{
  // Erros de conexão podem conter credenciais: não imprimir a exceção bruta.
  console.error('Falha na auditoria somente leitura. Confira conexão, datas e disponibilidade da medição.');
  process.exitCode=1;
}finally{await client.end();}
