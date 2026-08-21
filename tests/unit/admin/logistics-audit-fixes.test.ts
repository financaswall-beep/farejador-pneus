import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('correcoes confirmadas pela auditoria da Logistica', () => {
  it('vincula a rota administrativa a colaborador ativo e permite escolher entre rotas abertas', () => {
    const query = source('src/admin/painel/queries-logistica-rotas.ts');
    const schema = source('src/admin/painel/route-logistica.ts');
    const ui = source('painel/public/index.html');
    const module = source('painel/public/app.logistica.js');
    expect(schema).toContain("courier_collaborator_id: z.string().uuid('courier_required')");
    expect(query).toContain('(environment,courier_name,courier_collaborator_id,km_start,created_by)');
    expect(query).toContain("mc.job='entregador'");
    expect(ui).toContain('logisticaRotaAbertaId');
    expect(ui).toContain('logisticaCouriersDisponiveis()');
    expect(module).toContain("trips.find((trip) => trip.id === this.logisticaRotaAbertaId)");
  });

  it('limpa a identidade antiga e mostra cliente de balcao no app do entregador', () => {
    const route = source('src/admin/painel/queries-logistica-rotas.ts');
    const courier = source('src/admin/entregador/queries.ts');
    expect(route).toContain('trip_id = NULL, delivery_courier = NULL');
    expect(route).toContain('delivery_courier =\n              (SELECT courier_name');
    expect(courier).toContain('COALESCE(c.name,cu.name) AS customer_name');
    expect(courier).toContain('COALESCE(c.phone_e164,cu.phone_e164) AS customer_phone');
  });

  it('traduz erros no endpoint de upload e preserva a recuperacao de rota fechada', () => {
    const route = source('src/admin/caixa/route-deliveries.ts');
    const closeStart = route.indexOf("'/api/caixa/entregas/rota/fechar'");
    const uploadStart = route.indexOf("'/api/caixa/entregas/rota/comprovante'");
    const close = route.slice(closeStart, uploadStart);
    const upload = route.slice(uploadStart);
    const ui = source('painel/public/index.html');
    expect(close).not.toContain('ReceiptExactDuplicateError');
    expect(upload).toContain("error.message === 'receipt_limit'");
    expect(upload).toContain('error instanceof ReceiptExactDuplicateError');
    expect(ui).toContain('Anexar comprovante correto');
    expect(ui).toContain('enviarComprovante(logisticaRotaSelecionada(), $event)');
  });

  it('separa passado e futuro e nao corta historico em 30 pedidos ou 10 rotas', () => {
    const period = source('painel/public/app.logistica.resultado.js');
    const read = source('src/admin/painel/queries-logistica-read.ts');
    expect(period).toContain("this.logisticaTab === 'historico'");
    expect(period).toContain("? 'Últimos 7 dias' : 'Próximos 7 dias'");
    expect(read).not.toContain('DESC LIMIT 30');
    expect(read).not.toContain('DESC LIMIT 10');
    expect(read).toContain("AT TIME ZONE 'America/Sao_Paulo')::date - 29");
  });

  it('protege retorno fisico e o limite concorrente no banco', () => {
    const migration = source('db/migrations/0191_logistics_audit_corrections.sql');
    const partner = source('src/parceiro/queries.ts');
    const deliveryReturn = source('src/parceiro/delivery-return.ts');
    expect(migration).toContain('cancel_partner_local_order_v0090');
    expect(migration).toContain('matriz_trip_receipt_limit_guard');
    expect(partner).toContain('stock_release_pending_physical_return: true');
    expect(deliveryReturn).toContain('partner_delivery_return_confirmed');
  });
});
