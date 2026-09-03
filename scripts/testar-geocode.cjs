#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// Testa a GOOGLE_MAPS_API_KEY de verdade: geocodifica "Bangu, Rio de Janeiro" e
// faz um Distance Matrix Bangu→Copacabana. Usa a MESMA lógica do app
// (src/shared/geo/google-maps.ts): region=br, language=pt-BR.
//
// NUNCA imprime a chave. Só diz se o Google respondeu OK e a coordenada.
//
//   FAREJADOR_ENV=test ALLOW_EXTERNAL_GEOCODE_PROBE=google-maps \
//     node --env-file=.env scripts/testar-geocode.cjs
//
// ⚠️ Se a chave for restrita por IP (comum em chave de servidor), rodar daqui pode
//    dar REQUEST_DENIED mesmo a chave funcionando no Coolify — nesse caso o teste
//    confiável é refazer o pedido do Bangu ao vivo e eu leio o banco.
// ─────────────────────────────────────────────────────────────────────────────
const key = process.env.GOOGLE_MAPS_API_KEY;
const environment = process.env.FAREJADOR_ENV;

if (!['prod', 'test'].includes(environment)) {
  console.error('FAREJADOR_ENV deve ser informado explicitamente como prod ou test.');
  process.exit(1);
}
if (process.env.ALLOW_EXTERNAL_GEOCODE_PROBE !== 'google-maps') {
  console.error('Este teste chama APIs externas. Confirme com ALLOW_EXTERNAL_GEOCODE_PROBE=google-maps.');
  process.exit(1);
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { httpOk: res.ok, httpStatus: res.status, body: await res.json() };
  } catch (e) {
    clearTimeout(t);
    return { httpOk: false, httpStatus: 0, body: { status: 'FETCH_FAILED', error: String(e.message) } };
  }
}

(async () => {
  if (!key || !key.trim()) {
    console.log('❌ GOOGLE_MAPS_API_KEY AUSENTE/VAZIA no ambiente deste comando.');
    console.log('   (Isso aqui é o ambiente local, não o Coolify — mas se você passou a chave e deu isso, ela não chegou.)');
    process.exit(1);
  }
  console.log(`Ambiente: ${environment}. Chave presente, valor não exibido.\n`);

  // 1. GEOCODE Bangu
  const gParams = new URLSearchParams({ address: 'Bangu, Rio de Janeiro, Brasil', key, region: 'br', language: 'pt-BR' });
  const g = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${gParams}`);
  const gStatus = g.body && g.body.status;
  console.log('── GEOCODE "Bangu, Rio de Janeiro" ──');
  console.log('  HTTP:', g.httpStatus, '| Google status:', gStatus);
  if (gStatus === 'OK') {
    const loc = g.body.results?.[0]?.geometry?.location;
    const conf = g.body.results?.[0]?.geometry?.location_type;
    console.log(`  ✅ coordenada: ${loc.lat}, ${loc.lng}  (confiança: ${conf})`);
    console.log('     (Bangu real fica ~ -22.88, -43.46 — Zona Oeste)');
  } else {
    console.log('  ❌ não geocodificou.', g.body?.error_message ? 'msg: ' + g.body.error_message : '');
    console.log('     REQUEST_DENIED = chave inválida/restrita ou API/billing off. ZERO_RESULTS = texto.');
  }

  // 2. DISTANCE MATRIX Bangu -> Copacabana
  const dParams = new URLSearchParams({
    origins: '-22.8772,-43.4654', destinations: '-22.984613,-43.198278',
    key, mode: 'driving', region: 'br', language: 'pt-BR',
  });
  const d = await getJson(`https://maps.googleapis.com/maps/api/distancematrix/json?${dParams}`);
  const dStatus = d.body && d.body.status;
  console.log('\n── DISTANCE MATRIX Bangu→Copacabana ──');
  console.log('  HTTP:', d.httpStatus, '| Google status:', dStatus);
  const el = d.body?.rows?.[0]?.elements?.[0];
  if (dStatus === 'OK' && el?.status === 'OK') {
    console.log(`  ✅ distância de rua: ${(el.distance.value / 1000).toFixed(1)} km`);
  } else {
    console.log('  ❌ elemento:', el?.status || '(sem elemento)', d.body?.error_message ? '| msg: ' + d.body.error_message : '');
  }

  console.log('\nResumo: se os DOIS deram ✅, a chave funciona — o problema era o redeploy.');
  console.log('Se deu REQUEST_DENIED, conserte no Google Cloud (ativar API + billing + revisar restrição).');
})();
