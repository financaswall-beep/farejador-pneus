// Prévia local com dados fictícios; não inicia o Farejador nem consulta bancos.
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { fixturePayload } = require('./prova-parceiro-dados.cjs');
const { pickupPreviewCss } = require('./prova-parceiro-retiradas-dados.cjs');
const root = path.resolve(__dirname, '../painel/public');
const port = Number(process.env.PARTNER_PREVIEW_PORT || 8765);
const extensions = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const routes = require('node:fs').readFileSync(path.resolve(__dirname, '../src/admin/caixa/route-static.ts'), 'utf8');
const files = new Map([...routes.matchAll(/text\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map(match => [match[1], match[2]]));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + port);
  const fixture = url.pathname.startsWith('/_preview/');
  try {
    if (url.pathname === '/_preview-assets/pickup-demo.webp' || /\/operacao\/retiradas\/[^/]+\/itens\/[^/]+\/foto$/.test(url.pathname)) {
      const image = await readFile(path.resolve(__dirname, 'fixtures/partner-pickup-demo.webp'));
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }); res.end(image); return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/parceiro/')) {
      let input = {};
      if (req.method !== 'GET') {
        const buffers = []; for await (const chunk of req) buffers.push(chunk);
        if (String(req.headers['content-type']).includes('application/json')) {
          try { input = JSON.parse(Buffer.concat(buffers).toString()); } catch { /* fixture */ }
        }
      }
      let body = fixturePayload(req, url, input) || {};
      if (url.pathname.endsWith('/me')) body = { display_name: 'João Meier', username: 'joao', role: 'owner', store_name: url.pathname.startsWith('/parceiro/') ? 'Borracharia Meier' : 'Matriz 2W', modules: { vendas: true, estoque: true, retiradas: true, entregas: true, financeiro: true } };
      else if (url.pathname.endsWith('/photo-requests')) body = { enabled: true, photo_requests: [] };
      else if (url.pathname.endsWith('/notificacoes')) body = { notifications: [] };
      else if ((url.pathname.endsWith('/vendas') || url.pathname.endsWith('/minhas-vendas')) && !body.daily_series) body = { summary: {}, sales: [], daily_series: [] };
      else if (url.pathname.endsWith('/photo-stream-ticket')) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'feature_off' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body)); return;
    }
    let file = fixture ? 'caixa.html' : files.get(url.pathname);
    if (!file && url.pathname.startsWith('/operacao/')) file = url.pathname.slice('/operacao/'.length);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let content = await readFile(target);
    if (fixture) {
      const partner = url.pathname === '/_preview/parceiro';
      const scenario = ['avisos','foto','fotos-duas','retirada','retirada-uma','retiradas','entrega','esperando','fila'].includes(url.searchParams.get('cenario')) ? url.searchParams.get('cenario') : 'vazio';
      // Reabrir a prévia começa uma simulação nova, sem renovar prazos de pedidos reais.
      const values = { '2w_caixa_token': 'preview-only-' + scenario + ':' + randomUUID(), '2w_caixa_nome': 'João Meier', '2w_caixa_usuario': 'joao',
        '2w_caixa_escopo': partner ? 'partner' : 'matrix', '2w_caixa_unidade_slug': partner ? 'meier' : '',
        '2w_caixa_unidade_nome': partner ? 'Borracharia Meier' : 'Matriz 2W', '2w_caixa_papel': 'owner',
        '2w_caixa_modulos': JSON.stringify({ vendas: true, estoque: true, retiradas: true, entregas: true, financeiro: true }) };
      const setup = '<script>for(const [key,value] of Object.entries(' + JSON.stringify(values) + '))sessionStorage.setItem(key,value);</script>';
      content = content.toString().replace('<head>', '<head>' + setup);
      content = content.replace('</head>', pickupPreviewCss + '</head>');
    }
    res.writeHead(200, { 'Content-Type': extensions[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log('Prévia: http://127.0.0.1:' + port + '/_preview/parceiro'));
