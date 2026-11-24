import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { pool } from '../../persistence/db.js';
import { getMarketReference, marketReferenceSchema, setMarketReference } from '../../shared/catalog-market-reference.js';
import { listMatrizStockGroups, moveMatrizStockGroup, saveMatrizStockGroup } from '../painel/stock-groups.js';
import { listMatrizStockGroupOptions, stockGroupId, stockGroupSchema, stockGroupMoveSchema } from '../painel/stock-group-inputs.js';
import { registerInventoryRead as read, registerInventoryWrite as write } from './inventory-registry.js';
import './stock-origin-tools.js';

read('consultar_pilhas_galpao','Localize o stock_id e o product_id por medida e marca. Consulte o stock_id para ver o Modelo / desenho registrado em cada grupo, as pilhas e as quantidades físicas e reservadas. Informe a origem a conferir quando origin_pending for verdadeiro. Consulte a revisão antes de movimentar.',
  z.object({stock_id:stockGroupId.optional(),medida:z.string().trim().min(1).max(60).optional(),
    marca:z.string().trim().min(1).max(120).optional()}).strict()
    .refine(data=>Boolean(data.stock_id || data.medida || data.marca),'Informe estoque, medida ou marca.'),
  async data => {
    const variantes = await listMatrizStockGroupOptions(pool,env.FAREJADOR_ENV,data.stock_id,data.medida,data.marca);
    return {variantes,grupos:data.stock_id && variantes.length
      ? await listMatrizStockGroups(pool,env.FAREJADOR_ENV,data.stock_id) : []};
  });

write('stock','conferir_grupo_galpao','Consulte a variante e use model para o Modelo / desenho informado pela equipe. Registre a pilha e a quantidade já contabilizada. Se o dono só indicou a pilha, use located. Marque matched_set somente quando o operador confirmar que as unidades de mesma medida, marca e Modelo / desenho formam conjunto e, em usados, têm desgaste parecido. Registre o avulso separado do conjunto. Conservação é opcional. Para editar use group_id e revision.',
  stockGroupSchema,(db,data,actor)=>saveMatrizStockGroup(db,env.FAREJADOR_ENV,data,actor));
write('stock','mover_pneus_entre_pilhas','Movimente uma quantidade livre do grupo confirmado. Consulte a revisão atual. Origem vazia classifica unidades livres do estoque. Destino vazio retira a classificação física. Mover entre pilhas preserva o saldo do galpão.',
  stockGroupMoveSchema,(db,data,actor)=>moveMatrizStockGroup(db,env.FAREJADOR_ENV,data,actor));

read('consultar_referencia_online','Consulte o Modelo / desenho pesquisado do pneu novo, o valor, as fontes, a data e a autorização de uso no atendimento.',
  z.object({product_id:stockGroupId}).strict(),async data=>({referencia:await getMarketReference(data.product_id)}));
write('catalog','salvar_referencia_online','Registre a cotação unitária em reais do pneu novo e informe em model o Modelo / desenho pesquisado. Uma URL é cotação única. Com várias ofertas distintas, informe a média conferida. Habilite uso em objeções do atendimento somente com aprovação, validade e correspondência com o Modelo / desenho da ficha técnica.',
  marketReferenceSchema,(db,data,actor)=>{
    // O registro MCP acrescenta uma chave operacional ao corpo já validado.
    const reference = marketReferenceSchema.innerType().strip().parse(data);
    return setMarketReference(reference,actor,env.FAREJADOR_ENV,pool,db);
  });
