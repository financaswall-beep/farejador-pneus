import { z } from 'zod';
import {registerInventoryWrite as write,registerInventoryRead as read} from './inventory-registry.js';
import {entryWholesaleStockSchema,setWholesaleStockSchema,removeWholesaleStockSchema,baixaWholesaleStockSchema,
  physicalStockCountSchema,correctWholesaleStockBrandSchema,transferWholesaleStockConditionSchema} from '../painel/route-schemas-stock.js';
import {addWholesaleStockEntryComRotulo,setWholesaleStockComRotulo,applyGalpaoBaixaManual} from '../painel/queries-galpao-movimentos.js';
import {deleteWholesaleStockComRotulo} from '../painel/queries-galpao-removal.js';
import {applyMatrizPhysicalStockCount} from '../painel/queries-stock-physical-count.js';
import {correctWholesaleStockBrand} from '../painel/queries-stock-brand-correction.js';
import {transferWholesaleStockCondition} from '../painel/queries-stock-condition-transfer.js';
import {lotSeparationSchema,separateTireLot} from '../painel/tire-lot-separation.js';
import {transferPlanSchema} from '../painel/tire-transfer-plan.js';
import {confirmTransferSchema,confirmTireTransfer,previewTireTransfer,reverseTransferSchema,reverseTireTransfer} from '../painel/tire-stock-transfers.js';
import {listTransferProducts,listTireTransfers} from '../painel/tire-transfer-read.js';
import {getMatrizStockReconciliation} from '../painel/queries-stock-reconciliation.js';
import {getStockCosts} from '../painel/queries-stock-costs.js';
import {listLotSeparationSources} from '../painel/queries-tire-lots.js';

write('stock','registrar_entrada_estoque','Soma pneus ao estoque por inventário encontrado, aporte, saldo inicial ou outra origem. Para compra de fornecedor use as ferramentas de compra.',entryWholesaleStockSchema,
  (db,data,actor)=>addWholesaleStockEntryComRotulo({...data,actor_label:actor},undefined,db));
write('stock','definir_estoque','Define quantidade física, custo, mínimo e observações da variante. Informe o motivo e confira as reservas.',setWholesaleStockSchema.extend({reason:z.string().trim().min(2).max(300)}),
  (db,data,actor)=>setWholesaleStockComRotulo({...data,actor_label:actor},undefined,db));
write('stock','remover_medida_estoque','Remove a variante do galpão conforme as regras do painel, preservando histórico. Confira medida, marca e condição.',removeWholesaleStockSchema,
  async(db,data,actor)=>{await deleteWholesaleStockComRotulo({...data,actor_label:actor},undefined,db);return {removida:true};});
write('stock','registrar_perda_estoque','Baixa pneus por quebra, perda ou uso interno; exige quantidade, natureza e motivo. Não registra venda.',baixaWholesaleStockSchema,
  (db,data,actor)=>applyGalpaoBaixaManual({...data,actor_label:actor},undefined,db));
write('stock','registrar_contagem_estoque','Concilia a contagem física informada pelo dono, por medida, marca e condição. Não invente contagens; respeita reservas.',physicalStockCountSchema,
  (db,data,actor)=>applyMatrizPhysicalStockCount({...data,actor_label:actor},undefined,db));
write('stock','corrigir_marca_estoque','Corrige a marca da variante identificada, com motivo e validação de catálogo.',correctWholesaleStockBrandSchema,
  (db,data,actor)=>correctWholesaleStockBrand({...data,actor_label:actor},undefined,db));
write('stock','alterar_condicao_estoque','Transfere a quantidade entre condições, preservando custo e histórico.',transferWholesaleStockConditionSchema,
  (db,data,actor)=>transferWholesaleStockCondition({...data,actor_label:actor},undefined,db));
write('stock','separar_lote_estoque','Separa pneus de uma variante em um lote identificado, preservando quantidade e custo.',lotSeparationSchema,
  (db,data,actor)=>separateTireLot(data,actor,undefined,db));
read('simular_transferencia_estoque','Simula classificação, transferência para lote ou perda. Apresente o impacto e preserve o fingerprint retornado.',z.object({input:transferPlanSchema}).strict(),data=>previewTireTransfer(data.input));
write('stock','confirmar_transferencia_estoque','Executa a transferência simulada. Exige o fingerprint da simulação; mudanças de saldo ou custo exigem nova simulação e autorização.',confirmTransferSchema.extend({input:transferPlanSchema}),
  (db,data,actor)=>confirmTireTransfer(data.input,data.fingerprint,data.idempotency_key,actor,undefined,db));
write('stock','estornar_transferencia_estoque','Estorna a transferência identificada quando não há movimentos posteriores impeditivos.',reverseTransferSchema,
  (db,data,actor)=>reverseTireTransfer(data,actor,undefined,db));
read('consultar_conferencia_estoque','Conferência do saldo físico, reservas e conciliação do galpão.',z.object({}).strict(),()=>getMatrizStockReconciliation());
read('consultar_custos_estoque','Custos e posição de estoque conforme o painel.',z.object({tipo_veiculo:z.enum(['all','motorcycle','car']).default('all')}).strict(),data=>getStockCosts(undefined,data.tipo_veiculo));
read('consultar_origens_separacao','Localiza variantes disponíveis para separar um lote.',z.object({busca:z.string().trim().max(100).default('')}).strict(),data=>listLotSeparationSources(data.busca));
read('consultar_produtos_transferencia','Localiza os produtos aceitos nas transferências de lote/estoque.',z.object({busca:z.string().trim().max(100).default('')}).strict(),data=>listTransferProducts(data.busca));
read('consultar_transferencias_estoque','Histórico de transferências para consultar antes de estornar ou repetir uma operação.',z.object({lot_id:z.string().uuid().optional(),stock_id:z.string().uuid().optional(),page:z.number().int().min(1).max(100000).default(1)}).strict(),listTireTransfers);
