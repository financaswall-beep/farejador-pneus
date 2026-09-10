// Gera somente a camada de terra ao redor do mapa, sem mudar seus municípios interativos.
// Fonte: snapshot público do IBGE preservado no projeto; sem acesso à rede no build/runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(__dirname, 'data/rj-municipios-ibge.geojson'));
const raw = fs.readFileSync(source);
const geo = JSON.parse(raw);
assert.equal(geo.type, 'FeatureCollection');
assert.equal(geo.features.length, 92);
// Mesma projeção da malha existente: longitude mínima -43.939, latitude máxima
// -22.2026, largura 700 e correção da longitude pela latitude média -22.6389.
const scaleX = 700 / 1.8071;
const scaleY = scaleX / Math.cos(22.6389 * Math.PI / 180);
const project = ([lon, lat]) => [Math.round((lon + 43.939) * scaleX), Math.round((-22.2026 - lat) * scaleY)];
const ringPath = ring => ring.map((p, i) => (i ? 'L' : 'M') + project(p).join(',')).join('') + 'Z';
const shapes = geo.features.map(f => {
  assert(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return { id: f.properties.codarea, d: polygons.flatMap(p => p.map(ringPath)).join('') };
});
const target = path.join(root, 'painel/public/mapa-rm-dados.js');
const marker = '// CONTEXTO GEOGRÁFICO — gerado por scripts/gerar-contexto-mapa.cjs';
const base = fs.readFileSync(target, 'utf8').split(marker)[0].trimEnd();
const hash = crypto.createHash('sha256').update(raw).digest('hex');
const output = base + '\n\n' + marker + '\nwindow.MAPA_RM.contexto = {\n' +
  '  fonte: "IBGE — malha municipal do Rio de Janeiro",\n  sha256: ' + JSON.stringify(hash) + ',\n  municipios: [\n' +
  shapes.map(s => '    ' + JSON.stringify(s)).join(',\n') + '\n  ],\n};\n';
fs.writeFileSync(target, output);
console.log(JSON.stringify({ municipiosDeContexto: shapes.length, sha256: hash, destino: target }));
