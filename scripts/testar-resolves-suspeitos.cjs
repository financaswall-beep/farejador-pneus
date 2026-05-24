'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const cases = [
      // Padrao do Fan: nome curto + ano da geracao nova
      ['Titan', 2019, 'Honda Titan (CG 150 ate 2015, CG 160 dali em diante)'],
      ['titan', 2019, 'minusculo'],
      ['Cargo', 2020, 'CG 160 Cargo — so existe na geracao moderna'],
      ['Start', 2020, 'CG 160 Start — so existe na geracao moderna'],
      ['Factor', 2020, 'Yamaha Factor (YBR 125 ate 2016, YBR 150 dali em diante)'],
      ['factor', 2020, 'minusculo'],
      ['YBR Factor', 2020, 'composto'],
      ['Crosser', 2025, 'Yamaha XTZ 150 Crosser (legado 2015-2024, S 2025+)'],
      ['Crosser', 2018, 'mesma moto, ano legado'],
      ['XTZ Crosser', 2025, 'composto, ano novo'],
      // Controle: Fan ja foi consertado
      ['Fan', 2019, 'CONTROLE — deve achar CG 160 Fan agora'],
      ['Fan', 2012, 'CONTROLE — deve achar CG 150 Fan'],
    ];

    for (const [m, y, comentario] of cases) {
      const r = await c.query(
        "SELECT make, model, variant, year_start, year_end, match_type, match_similarity FROM commerce.resolve_vehicle_model('prod'::env_t, $1, $2, 0.4);",
        [m, y]
      );
      console.log(`\nresolve('${m}', ${y})  -- ${comentario}`);
      if (r.rows.length === 0) console.log('  VAZIO ⚠');
      else for (const row of r.rows) console.log('  ', row);
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
