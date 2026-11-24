import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { pool } from '../../persistence/db.js';
import { getMarketReference, marketReferenceSchema, setMarketReference } from '../../shared/catalog-market-reference.js';
import { listMatrizStockGroups, moveMatrizStockGroup, saveMatrizStockGroup } from '../painel/stock-groups.js';
import { listMatrizStockGroupOptions, stockGroupId, stockGroupSchema, stockGroupMoveSchema } from '../painel/stock-group-inputs.js';
import { registerInventoryRead as read, registerInventoryWrite as write } from './inventory-registry.js';
import './stock-origin-tools.js';

read('consultar_pilhas_galpao','Localize o stock_id e o product_id da variante informando medida e marca. Use o stock_id para ver grupos, pilhas, quantidades livres/reservadas, notas de conservação e revisão antes de movimentar.',
  z.object({stock_id:stockGroupId.optional(),medida:z.string().trim().min(1).max(60).optional(),
    marca:z.string().trim().min(1).max(120).optional()}).strict()
    .refine(data=>Boolean(data.stock_id || data.medida || data.marca),'Informe estoque, medida ou marca.'),
  async data => {
    const variantes = await listMatrizStockGroupOptions(pool,env.FAREJADOR_ENV,data.stock_id,data.medida,data.marca);
    return {variantes,grupos:data.stock_id && variantes.length
      ? await listMatrizStockGroups(pool,env.FAREJADOR_ENV,data.stock_id) : []};
  });

write('stock','conferir_grupo_galpao','Registre pilha e quantidade de pneus já contabilizados. Se o dono informou apenas a posição, use located. Para matched_set, o operador precisa confirmar o conjunto de mesma medida, marca e modelo/desenho e, em usados, desgaste parecido. Cadastre o avulso em grupo próprio. Conservação é opcional. Consulte a variante primeiro. Para editar use group_id e revision.',
  stockGroupSchema,(db,data,actor)=>saveMatrizStockGroup(db,env.FAREJADOR_ENV,data,actor));
write('stock','mover_pneus_entre_pilhas','Movimente uma quantidade livre do grupo confirmado. Consulte a revisão atual. Origem vazia classifica unidades livres do estoque. Destino vazio retira a classificação física. Mover entre pilhas preserva o saldo do galpão.',
  stockGroupMoveSchema,(db,data,actor)=>moveMatrizStockGroup(db,env.FAREJADOR_ENV,data,actor));

read('consultar_referencia_online','Consulte a pesquisa interna do pneu NOVO, seu modelo, fontes, data e autorização de uso no atendimento.',
  z.object({product_id:stockGroupId}).strict(),async data=>({referencia:await getMarketReference(data.product_id)}));
write('catalog','salvar_referencia_online','Registre a cotação unitária em reais do pneu novo. Uma URL é cotação única. Com várias ofertas distintas, informe a média conferida. Use a versão exata e datas da pesquisa. Habilite uso em objeções do atendimento somente com aprovação, validade e modelo confirmado no catálogo.',
  marketReferenceSchema,(db,data,actor)=>{
    // O registro MCP acrescenta uma chave operacional ao corpo já validado.
    const reference = marketReferenceSchema.innerType().strip().parse(data);
    return setMarketReference(reference,actor,env.FAREJADOR_ENV,pool,db);
  });
