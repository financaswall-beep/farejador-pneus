/**
 * Regressao do painel unico: prova que a Operacao da Loja escolhe o motor de
 * venda pelo local autenticado. Parceiro usa a rota/pool/RLS do parceiro;
 * Matriz usa o Caixa e o motor walk-in da unidade main.
 *
 * Uso: npm run prova-vendas-roteamento
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createCaixaSaleSchema } from '../src/admin/caixa/sale-schema.js';
import { partnerSaleSchema } from '../src/parceiro/sale-schema.js';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

function mustMatch(label: string, content: string, pattern: RegExp): void {
  assert.match(content, pattern, `[FALHA] ${label}`);
  console.log(`[OK] ${label}`);
}

const caixaCore = source('painel/public/caixa-core.js');
const caixaCheckout = source('painel/public/caixa-checkout.js');
const caixaCatalog = source('painel/public/caixa-checkout-catalog.js');
const operationLogin = source('src/admin/caixa/route-operation-login.ts');
const caixaQueries = source('src/admin/caixa/queries.ts');
const caixaRoute = source('src/admin/caixa/route.ts');
const caixaService = source('src/admin/caixa/checkout.ts');
const walkinOrder = source('src/admin/painel/walkin-order.ts');
const partnerRoute = source('src/parceiro/route.ts');
const partnerQueries = source('src/parceiro/queries.ts');
const partnerDb = source('src/parceiro/db.ts');
const legacyCore = source('parceiro/public/app.core.js');
const legacyPdv = source('parceiro/public/app.pdv.js');

mustMatch(
  'o navegador manda o parceiro para /parceiro/:slug/api',
  caixaCore,
  /function operationPath\s*\(resource,\s*matrixPath\)[\s\S]*?if\s*\(isPartner\(\)\)\s*return\s*'\/parceiro\/'\s*\+\s*encodeURIComponent\(slug\(\)\)\s*\+\s*'\/api\/'\s*\+\s*resource;/,
);
mustMatch(
  'o checkout escolhe vendas pelo escopo autenticado',
  caixaCheckout,
  /Caixa\.operationPath\(\s*'vendas'\s*,\s*'\/api\/caixa\/vendas'\s*\)/,
);
mustMatch(
  'o login de parceiro emite ps_ e conserva slug/escopo',
  operationLogin,
  /mintPartnerSession\(environment,\s*workplace\.tokenId\)[\s\S]*?scope:\s*'partner'[\s\S]*?slug:\s*workplace\.slug/,
);
mustMatch(
  'a sessao do Caixa continua exclusiva do prefixo cs_',
  caixaQueries,
  /const CAIXA_SESSION_PREFIX\s*=\s*'cs_'[\s\S]*?\^cs_\[a-f0-9\]\{64\}\$/,
);
mustMatch(
  'a rota do parceiro chama registerPartnerSale com contexto autenticado',
  partnerRoute,
  /fastify\.post\('\/parceiro\/:slug\/api\/vendas'[\s\S]*?requirePartnerAuth[\s\S]*?requireScreen\('vendas'\)[\s\S]*?registerPartnerSale\(getPartnerContext\(request\),\s*parsed\.data\)/,
);

const partnerSale = partnerQueries.slice(
  partnerQueries.indexOf('export async function registerPartnerSale'),
  partnerQueries.indexOf('export async function cancelPartnerSale'),
);
assert.ok(partnerSale.length > 0, '[FALHA] registerPartnerSale nao localizado');
mustMatch(
  'a venda do parceiro roda em withPartnerContext',
  partnerSale,
  /return withPartnerContext\(ctx\.partnerUnitId,\s*async\s*\(client\)/,
);
mustMatch(
  'a venda do parceiro usa uma unica funcao transacional',
  partnerSale,
  /commerce\.register_partner_local_order/,
);
mustMatch(
  'o contexto restrito planta app.partner_unit_id antes das queries',
  partnerDb,
  /partnerPool\.connect\(\)[\s\S]*?set_config\('app\.partner_unit_id',\s*\$1,\s*true\)/,
);
mustMatch(
  'o desktop legado tambem usa /parceiro/:slug/api',
  legacyCore,
  /fetch\(`\/parceiro\/\$\{this\.slug\}\/api\/\$\{path\}`/,
);
mustMatch(
  'o PDV legado chama o mesmo recurso vendas',
  legacyPdv,
  /this\.api\('vendas',\s*\{\s*method:\s*'POST'/,
);

mustMatch(
  'a API do Caixa valida somente cs_ antes da venda da Matriz',
  caixaRoute,
  /fastify\.post\('\/api\/caixa\/vendas'[\s\S]*?requireCaixaAuth[\s\S]*?requireVendas/,
);
mustMatch(
  'o Caixa da Matriz chama registerWalkinOrder',
  caixaService,
  /return registerWalkinOrder\([\s\S]*?unit_id:\s*null/,
);
mustMatch(
  'o walk-in permanece preso a unidade main',
  walkinOrder,
  /slug\s*=\s*'main'[\s\S]*?walkin_unit_not_found/,
);

type BodyFactory = (
  checkout: Record<string, unknown>,
  totals: { total: number },
) => unknown;
const sandbox = { window: { Caixa: { isPartner: () => true } } };
runInNewContext(caixaCatalog, sandbox);
const bodyFactory = (sandbox.window.Caixa as { saleRequestBody: BodyFactory }).saleRequestBody;
const itemId = '11111111-1111-4111-8111-111111111111';
const checkout = {
  customerName: 'Cliente de prova', customerPhone: '+5521999999999', payment: 'pix',
  idempotencyKey: 'caixa-portao-zero',
  cart: new Map([[itemId, {
    product: { product_id: itemId, partner_stock_id: itemId },
    quantity: 2, negotiatedPrice: 45.01, referencePrice: 50,
  }]]),
};
const totals = { total: 90.02 };

const partnerBody = bodyFactory(checkout, totals);
assert.ok(partnerSaleSchema.safeParse(partnerBody).success,
  '[FALHA] corpo gerado pelo /operacao nao passa no contrato de venda do parceiro');
console.log('[OK] corpo do /operacao passa no schema transacional do parceiro');

sandbox.window.Caixa.isPartner = () => false;
const matrixBody = bodyFactory(checkout, totals);
assert.ok(createCaixaSaleSchema.safeParse(matrixBody).success,
  '[FALHA] corpo gerado pelo /operacao nao passa no contrato do Caixa da Matriz');
console.log('[OK] corpo do /operacao passa no schema transacional da Matriz');

console.log('\n[OK] Roteamento: nao ha dois motores para a mesma venda do parceiro.');
console.log('     /operacao parceiro e desktop legado convergem em registerPartnerSale + RLS.');
