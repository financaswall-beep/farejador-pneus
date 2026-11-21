import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {Pool} from 'pg';
type Call=(name:string,args:object)=>Promise<any>;

export async function retailTripCase(pool:Pool,grantId:string,call:Call,approve:Call) {
  const key=randomUUID, at='2026-11-20T08:00:00-03:00';
  await pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES ('test','main','Matriz fictícia',true) ON CONFLICT(environment,slug) DO UPDATE SET is_active=true`);
  await pool.query(`UPDATE network.dot_oauth_grants SET retail_operations_enabled=true,route_operations_enabled=true WHERE id=$1`,[grantId]);
  await pool.query(`INSERT INTO commerce.matriz_expense_categories(environment,slug,label) VALUES ('test','alimentacao','Alimentação') ON CONFLICT DO NOTHING`);
  const product=(await pool.query(`INSERT INTO commerce.products(environment,product_type,product_code,product_name,brand,tire_condition)
    VALUES ('test','tire',$1,'Bridgestone de teste','Bridgestone','novo') RETURNING id`,[key()])).rows[0];
  await pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,'265/70-16')`,[product.id]);
  await pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test','265/70-16','Bridgestone','novo',8,22.50)`);
  await pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount,currency,valid_from)
    VALUES ('test',$1,200,'BRL','2026-01-01')`,[product.id]);
  const sale={idempotency_key:key(),customer_mode:'new',customer_name:'Cliente fictício de Campo Grande',
    sold_at:at,delivered_at:at,delivery_address:'Campo Grande, endereço de teste',freight:80,
    payments:[{payment_method:'pix',amount:880,cash_account:'Conta fictícia da Matriz'}],
    items:[{product_id:product.id,unit_price:200,quantity:4}]};
  const name='registrar_venda_balcao_matriz',routeName='registrar_rota_realizada_matriz';
  const stock=async()=>(await pool.query(`SELECT quantity_on_hand FROM commerce.wholesale_stock
    WHERE environment='test' AND measure='265/70-16' AND brand='Bridgestone'`)).rows[0].quantity_on_hand;
  const draft=await call(name,sale);
  expect(draft).toMatchObject({executada:false,dados:{efeitos:{produtos:800,entrada:880,frete:80,custo_dos_produtos:90}}});
  expect(await stock()).toBe(8);
  const saved=await approve(name,sale);
  expect(saved).toMatchObject({executada:true,resultado:{pago:true,baixa_registrada:true,recebido:880}});
  const order=saved.resultado.order_id;
  expect(await call(name,sale)).toEqual(saved);
  expect(await stock()).toBe(4);
  const ledger=await pool.query(`SELECT amount::float8 AS valor,metadata->>'cash_account' AS conta FROM finance.matriz_ledger_transactions
    WHERE environment='test' AND source_id=$1 AND cash_on IS NOT NULL`,[order]);
  expect(ledger.rows).toEqual([{valor:880,conta:'Conta fictícia da Matriz'}]);
  const linked=await approve('registrar_entrega_de_venda_matriz',{order_id:order,delivered_at:at,delivery_address:sale.delivery_address,idempotency_key:key()});
  expect(linked).toMatchObject({executada:true,resultado:{order_id:order,total:880,pago:true,trip_id:null}});
  expect(await stock()).toBe(4);
  const receipt=(await call('consultar_recebimentos_balcao_milly',{order_id:order})).recebimentos[0];
  expect(receipt).toMatchObject({valor:880,conta:'Conta fictícia da Matriz'});
  const corrected=await approve('corrigir_conta_recebimento_balcao',{order_id:order,recebimento_id:receipt.recebimento_id,
    conta_atual:receipt.conta,conta_correta:'Conta de teste corrigida',motivo:'Identificação da conta de teste',idempotency_key:key()});
  expect(corrected).toMatchObject({executada:true,resultado:{valor:880,conta:'Conta de teste corrigida'}});
  expect((await call('consultar_recebimentos_balcao_milly',{order_id:order})).recebimentos).toEqual([
    expect.objectContaining({recebimento_id:receipt.recebimento_id,conta_original:receipt.conta,conta:'Conta de teste corrigida'})]);
  const meal=(await pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,amount,occurred_at,payment_status,paid_at,description)
    VALUES ('test','alimentacao',15,$1,'paid',$1,'Lanche fictício') RETURNING id`,[at])).rows[0];
  const trip={idempotency_key:key(),started_at:'2026-11-20T07:30:00-03:00',ended_at:at,courier_name:'Entregador fictício',
    destination:'Campo Grande',deliveries:[{order_id:order,delivered_at:at}],expenses:[
      {category:'combustivel',description:'Abastecimento fictício',amount:80,occurred_at:at,payment_method:'pix',cash_account:'Conta fictícia'},
      {expense_id:meal.id}]};
  const preview=await call(routeName,trip);
  expect(preview).toMatchObject({executada:false,dados:{efeitos:{saida_nova:80,sobra_antes_das_despesas_gerais:695}}});
  expect((await call(routeName,{...trip,idempotency_key:key(),expenses:[...trip.expenses,{expense_id:key()}]})).isError).toBe(true);
  expect((await pool.query('SELECT trip_id FROM commerce.orders WHERE id=$1',[order])).rows[0].trip_id).toBeNull();
  const closed=await approve(routeName,trip);
  expect(closed).toMatchObject({executada:true,resultado:{status:'closed',produtos:800,frete:80,custo_pneus:90,gastos:95,sobra_antes_das_despesas_gerais:695}});
  expect(await call(routeName,trip)).toEqual(closed);
  expect((await call('consultar_resultado_rota_matriz',{rota_id:closed.resultado.rota_id})).sobra_antes_das_despesas_gerais).toBe(695);
  expect((await call(routeName,{...trip,idempotency_key:key()})).isError).toBe(true);
  expect((await pool.query('SELECT dispatched_at,delivered_at FROM commerce.orders WHERE id=$1',[order])).rows[0]).toEqual({dispatched_at:null,delivered_at:new Date(at)});
  expect(await stock()).toBe(4);
  expect((await call(name,{...sale,idempotency_key:key()})).isError).toBe(true);
  const at9='2026-11-20T09:00:00-03:00';
  const bundle={idempotency_key:key(),venda:{customer_mode:'new',customer_name:'Segundo cliente fictício',sold_at:at9,
    delivered_at:at9,delivery_address:'Campo Grande',freight:80,items:sale.items,
    payments:[{payment_method:'pix',amount:400,cash_account:'Conta A'},{payment_method:'dinheiro',amount:480,cash_account:'Caixa B'}]},
    viagem:{destination:'Campo Grande',started_at:at,ended_at:at9,courier_name:'Entregador fictício',
      outros_pedidos:[],expenses:[{category:'outros',description:'Estacionamento de teste',amount:8,occurred_at:at9,
        payment_method:'dinheiro',cash_account:'Caixa B'}]}};
  const bundleName='registrar_venda_e_rota_matriz';
  const proposed=await call(bundleName,bundle);
  expect(proposed).toMatchObject({executada:false,confirmacao:'conversa'});
  expect((await call('retomar_propostas_varejo_matriz',{})).propostas).toEqual(expect.arrayContaining([expect.objectContaining({proposta:proposed.proposta})]));
  await call('confirmar_operacao_milly',{proposta:proposed.proposta,fingerprint:proposed.fingerprint,autorizado_pelo_dono:true});
  // Simula falha depois de gravar pedido, pagamentos, estoque, rota e a despesa, dentro da transação.
  await pool.query(`CREATE FUNCTION commerce.test_fail_trip_link() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'falha_de_teste'; END $$;
    CREATE TRIGGER test_fail_trip BEFORE UPDATE OF delivery_trip_id ON commerce.matriz_expenses
    FOR EACH ROW EXECUTE FUNCTION commerce.test_fail_trip_link()`);
  try {
    expect((await call(bundleName,bundle)).isError).toBe(true);
    expect(await stock()).toBe(4);
    expect((await pool.query("SELECT id FROM commerce.customers WHERE name='Segundo cliente fictício'")).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM commerce.matriz_expenses WHERE description='Estacionamento de teste'")).rowCount).toBe(0);
  } finally {
    await pool.query('DROP TRIGGER test_fail_trip ON commerce.matriz_expenses');
  }
  const both=await call(bundleName,bundle);
  expect(both).toMatchObject({executada:true,resultado:{venda:{recebido:880},viagem:{gastos:8,sobra_antes_das_despesas_gerais:782}}});
  expect(await stock()).toBe(0);
  expect(await call(bundleName,bundle)).toEqual(both);
  const split=await pool.query(`SELECT amount::float8 AS valor,metadata->>'cash_account' AS conta FROM finance.matriz_ledger_transactions
    WHERE source_id=$1 AND cash_on IS NOT NULL ORDER BY amount`,[both.resultado.venda.order_id]);
  expect(split.rows).toEqual([{valor:400,conta:'Conta A'},{valor:480,conta:'Caixa B'}]);
  const move=await approve('corrigir_rota_de_despesa_matriz',{rota_origem:closed.resultado.rota_id,rota_destino:both.resultado.viagem.rota_id,
    expense_id:meal.id,motivo:'Despesa vinculada à viagem errada no teste',idempotency_key:key()});
  expect(move).toMatchObject({executada:true,resultado:{origem:{gastos:80},destino:{gastos:23}}});
  expect(await call('conferir_balcao_do_dia_matriz',{dia:'2026-11-20'})).toMatchObject({pedidos:2,vendido:1760,recebido:1760,para_conferir:[]});
}
