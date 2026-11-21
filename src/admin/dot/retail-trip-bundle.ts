import {z} from 'zod';
import type {PoolClient} from 'pg';
import {saleSchema,tripSchema,id,type Trip} from './retail-delivery-schemas.js';
import {salePreview,saveSale} from './retail-sale.js';
import {previewTrip,saveTrip} from './historical-trip.js';
import {registerInventoryWrite} from './inventory-registry.js';

const schema=z.object({idempotency_key:id,
  venda:saleSchema.omit({idempotency_key:true}).extend({delivered_at:z.string().datetime({offset:true}),
    delivery_address:z.string().trim().min(2).max(500)}).strict(),
  viagem:tripSchema.omit({idempotency_key:true,deliveries:true}).extend({
    outros_pedidos:tripSchema.shape.deliveries.element.array().max(99)}).strict(),
}).strict();
type Bundle=z.infer<typeof schema>;
function trip(data:Bundle,orderId:string):Trip {
  const {outros_pedidos,...fields}=data.viagem;
  return {...fields,idempotency_key:data.idempotency_key,
    deliveries:[{order_id:orderId,delivered_at:data.venda.delivered_at},...outros_pedidos]};
}
async function preview(db:PoolClient,data:Bundle) {
  const sale=await salePreview(db,{...data.venda,idempotency_key:data.idempotency_key});
  const plannedId=data.idempotency_key;
  const route=await previewTrip(db,trip(data,plannedId),{
    id:plannedId,numero_pedido:null,status:'delivered',trip_id:null,delivery_status:'delivered',created_at:data.venda.sold_at,
    delivered_at:data.venda.delivered_at,baixa_registrada:true,pago:true,itens_sem_custo:0,
    quantidade:data.venda.items.reduce((sum,i)=>sum+i.quantity,0),total:sale.entrada,produtos:sale.produtos,custo:sale.custo_dos_produtos,
  });
  return {venda:sale,viagem:route};
}
registerInventoryWrite('route','registrar_venda_e_rota_matriz',
  'Quando a mesma solicitação incluir uma nova venda paga e uma viagem já concluída, apresente uma única proposta com venda, baixa, Pix, pedidos e despesas. Grava tudo junto após autorização. Para pedido já existente use registrar_rota_realizada_matriz.',
  schema,async(db,data,actor)=>{
    const venda=await saveSale(db,{...data.venda,idempotency_key:data.idempotency_key},actor);
    const viagem=await saveTrip(db,trip(data,venda.order_id),actor);
    return {venda,viagem};
  },false,preview,'retail');
