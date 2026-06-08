/**
 * Prova do Bug 2: localizacao_loja/getUnitMapsUrl deve indicar a loja MAIS PERTO,
 * não a mais antiga. Read-only contra o banco (environment='prod').
 *
 * Rodar: npx tsx --env-file=.env scripts/prova-localizacao-proximidade.ts
 */
async function main() {
  const { pool } = await import('../src/persistence/db.js');
  const { getUnitMapsUrl } = await import('../src/atendente-v2/fulfillment.js');
  const client = await pool.connect();
  let fail = 0;
  const check = (ok: boolean, msg: string) => { if (!ok) fail++; console.log(`${ok ? '✅' : '❌'} ${msg}`); };
  try {
    // Coordenadas reais (geocode do Google) dos bairros do cliente.
    const bangu = { lat: -22.8741734, lng: -43.4686006 };       // Zona Oeste
    const copa = { lat: -22.9846, lng: -43.1983 };              // Zona Sul
    const meier = { lat: -22.9012, lng: -43.2782 };             // Zona Norte

    const rBangu = await getUnitMapsUrl(client, 'prod', { bairro: 'Bangu', municipio: 'Rio de Janeiro', customerLocation: bangu });
    console.log('Bangu + coord      →', rBangu?.nome_loja);
    check(rBangu?.nome_loja === 'Borracharia Madureira', 'Bangu indica a loja MAIS PERTO (Madureira), não Copacabana');

    const rCopa = await getUnitMapsUrl(client, 'prod', { bairro: 'Copacabana', municipio: 'Rio de Janeiro', customerLocation: copa });
    console.log('Copacabana + coord →', rCopa?.nome_loja);
    check(rCopa?.nome_loja === 'Borracharia Copacabana', 'Copacabana indica a loja de Copacabana (ela mesma)');

    const rMeier = await getUnitMapsUrl(client, 'prod', { bairro: 'Méier', municipio: 'Rio de Janeiro', customerLocation: meier });
    console.log('Méier + coord      →', rMeier?.nome_loja);
    check(rMeier?.nome_loja === 'Borracharia Méier', 'Méier indica a loja do Méier (ela mesma)');

    const rSemCoord = await getUnitMapsUrl(client, 'prod', { bairro: 'Bangu', municipio: 'Rio de Janeiro', customerLocation: null });
    console.log('Bangu SEM coord    →', rSemCoord === null ? 'null' : rSemCoord?.nome_loja);
    check(rSemCoord === null, 'Sem coordenada + várias lojas → null (bot pergunta o bairro, não chuta)');
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n=== ${fail === 0 ? 'TODOS OS CHECKS PASSARAM' : fail + ' FALHARAM'} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERRO:', e); process.exit(1); });
