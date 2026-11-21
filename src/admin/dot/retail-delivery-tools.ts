import {z} from 'zod';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {searchSaleCustomers} from '../painel/sale-customers.js';
import {registerInventoryRead as read,registerInventoryWrite as write} from './inventory-registry.js';
import {tripSchema,saleSchema,id} from './retail-delivery-schemas.js';
import {salePreview,saveSale,retailOrder} from './retail-sale.js';
import {previewTrip,saveTrip,tripResult} from './historical-trip.js';

read('localizar_cliente_balcao_matriz','Localiza o cadastro pelo nome ou telefone no seletor de clientes do balcão. Use a referência selecionada na venda.',
  z.object({busca:z.string().trim().min(2).max(150)}).strict(),data=>searchSaleCustomers(env.FAREJADOR_ENV,data.busca));
read('localizar_venda_balcao_matriz','Procure o pedido antes de lançar a venda. Consulte pelo número ou por dia e total, no horário de Brasília. Para vincular um pedido existente use seu order_id na rota.',
  z.object({numero_pedido:z.string().trim().min(1).max(50).optional(),dia:z.string().date().optional(),total:z.number().positive().optional()})
    .strict().refine(d=>!!d.numero_pedido||!!d.dia),async data=>{
      const result=await pool.query(`SELECT o.id AS order_id,o.order_number AS numero_pedido,o.status,o.created_at,
        o.total_amount::float8 total,COALESCE(c.name,ct.name) cliente,o.trip_id
        FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
        LEFT JOIN commerce.customers c ON c.environment=o.environment AND c.id=o.customer_id
        LEFT JOIN core.contacts ct ON ct.environment=o.environment AND ct.id=o.contact_id
        WHERE o.environment=$1 AND o.partner_order_id IS NULL AND ($2::text IS NULL OR o.order_number=$2)
        AND ($3::date IS NULL OR (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date=$3)
        AND ($4::numeric IS NULL OR o.total_amount=$4) ORDER BY o.created_at DESC,o.id LIMIT 51`,
      [env.FAREJADOR_ENV,data.numero_pedido??null,data.dia??null,data.total??null]);
      return {pedidos:result.rows.slice(0,50),truncado:result.rows.length>50};
    });
read('localizar_gasto_viagem_matriz','Localiza despesas da Matriz pelo dia da viagem, valor e categoria. Compare a descrição e use o ID da despesa existente na proposta da rota.',
  z.object({dia:z.string().date(),valor:z.number().positive().optional(),categoria:z.string().trim().min(2).max(80).optional()}).strict(),async data=>{
    const result=await pool.query(`SELECT e.id AS expense_id,e.category,e.description,e.amount::float8 AS valor,e.occurred_at,e.payment_status,e.delivery_trip_id AS rota_historica
      FROM commerce.matriz_expenses e WHERE e.environment=$1 AND e.deleted_at IS NULL
      AND e.occurred_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND e.occurred_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND ($3::numeric IS NULL OR e.amount=$3) AND ($4::text IS NULL OR e.category=$4)
      ORDER BY e.occurred_at,e.id LIMIT 51`,[env.FAREJADOR_ENV,data.dia,data.valor??null,data.categoria??null]);
    return {despesas:result.rows.slice(0,50),truncado:result.rows.length>50};
  });
write('retail','registrar_venda_balcao_matriz','Venda paga de balcão da Matriz. Procure primeiro vendas e cliente existentes. Se uma venda parecida for realmente distinta, mencione seu número ao dono e informe seu ID em vendas_distintas_de. Informe a data e hora com fuso, produtos, preço, frete e conta de cada recebimento. Para entrega já feita, informe endereço e delivered_at. Não abre despacho.',
  saleSchema,saveSale,false,salePreview);
read('consultar_baixa_venda_matriz','Confere número do pedido, total, pagamento registrado, custo e baixa no galpão da Matriz.',
  z.object({order_id:id}).strict(),data=>retailOrder(pool,data.order_id));
write('route','registrar_rota_realizada_matriz','Registra uma viagem já terminada em uma única proposta. Use IDs de pedidos existentes, horas reais com fuso e destino. Informe expense_id para despesas já lançadas. Só informe despesas novas após procurar as existentes. Não despacha nem envia mensagem.',
  tripSchema,saveTrip,false,previewTrip);
read('consultar_resultado_rota_matriz','Resultado da viagem no painel da Matriz, com pneus, frete, custo, despesas e sobra antes das despesas gerais.',
  z.object({rota_id:id}).strict(),data=>tripResult(pool,data.rota_id));
