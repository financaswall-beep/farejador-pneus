import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import { repairVehicleApplicationTypes } from '../../shared/vehicle-application-type-repair.js';
import { referenceSelection, classifyMotorcycleReferences } from '../painel/catalog-reference-classification.js';
import {registerInventoryWrite as write,registerInventoryRead as read} from './inventory-registry.js';
import {createProductBody,tireSpecBody,priceBody,compatibilityBody,compatibilityDeleteBody,compatibilityDeleteParams,
  discoveryBody,discoveryReviewBody,vehicleSearchQuery} from '../painel/route-catalogo-schemas.js';
import {createCatalogProduct} from '../painel/queries-catalogo-create.js';
import {createCatalogProductFromStock} from '../painel/queries-catalogo-create-stock.js';
import {updateCatalogTireSpec} from '../painel/queries-catalogo-spec.js';
import {setCatalogPrice,getCatalogPriceHistory} from '../painel/queries-catalogo-prices.js';
import {setCatalogWholesalePrice,getCatalogWholesaleHistory} from '../painel/queries-catalogo-wholesale.js';
import {addCatalogCompatibility,removeCatalogCompatibility,getCatalogCompatibility,getCatalogMeasureApplications} from '../painel/queries-catalogo-compatibilidade.js';
import {createCatalogFitmentDiscovery,getCatalogFitmentDiscoveries} from '../painel/queries-catalogo-discoveries.js';
import {reviewCatalogFitmentDiscovery} from '../painel/queries-catalogo-discovery-review.js';
import {searchCatalogVehicleModels} from '../painel/catalog-vehicle-models.js';
const product=z.object({product_id:z.string().uuid()}).strict();
write('catalog','cadastrar_produto_catalogo','Cadastra pneu a partir do estoque ou cadastro manual, com marca, medida, condição e dados técnicos. Modelo / desenho do pneu vai em tread_pattern. Se o retorno trouxer referencias_para_classificar, mostre os modelos de moto ao dono e proponha classificar_referencias_moto.',createProductBody,
  async (db,data,actor)=>{
    const input={measure:data.measure,brand:data.brand,tireCondition:data.tire_condition,productCode:data.product_code,
      productName:data.product_name,vehicleType:data.vehicle_type,treadPattern:data.tread_pattern,loadIndex:data.load_index,
      speedRating:data.speed_rating,position:data.position,priceAmount:data.price_amount,priceReason:data.price_reason,actorLabel:actor};
    const create = data.creation_mode === 'manual' ? createCatalogProduct : createCatalogProductFromStock;
    const created = await create(input, undefined, db);
    const refs = created.vehicle_type === 'motorcycle' && applicationMeasureKey(created.tire_size)
      ? (await repairVehicleApplicationTypes(db, env.FAREJADOR_ENV, created.tire_size)).applications : [];
    return { ...created, referencias_para_classificar: refs };
  });
write('catalog','editar_ficha_catalogo','Use tread_pattern para o Modelo / desenho do pneu e position para a posição no veículo. Após classificar um pneu como Moto, consulte a ficha para conferir referencias_para_classificar. Altera somente os dados técnicos enviados. Omita para preservar e use null para limpar. Informe o motivo.',tireSpecBody.extend(product.shape),
  (db,data,actor)=>updateCatalogTireSpec({productId:data.product_id,vehicleType:data.vehicle_type,treadPattern:data.tread_pattern,
    loadIndex:data.load_index,speedRating:data.speed_rating,position:data.position,reason:data.reason,actorLabel:actor},undefined,db));
write('catalog','alterar_preco_catalogo','Altera o preço de varejo do pneu identificado. Valor em reais, com motivo e histórico.',priceBody.extend(product.shape),
  (db,data,actor)=>setCatalogPrice({productId:data.product_id,priceAmount:data.price_amount,reason:data.reason,actorLabel:actor},undefined,db));
write('catalog','alterar_preco_atacado_catalogo','Altera o preço de atacado; null remove o preço oficial de atacado conforme o painel.',priceBody.extend({...product.shape,price_amount:priceBody.shape.price_amount.nullable()}),
  (db,data,actor)=>setCatalogWholesalePrice({productId:data.product_id,priceAmount:data.price_amount,reason:data.reason,actorLabel:actor},undefined,db));
// A validação dos anos continua no schema compartilhado e no serviço do painel.
const fitment=compatibilityBody.innerType().extend(product.shape).superRefine((data,ctx)=>{
  const parsed=compatibilityBody.safeParse(data);if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue(issue);
});
write('catalog','salvar_compatibilidade_catalogo','Adiciona uma faixa. Para corrigir, consulte a ficha e informe previous_period com os anos anteriores e year_start/year_end com os novos. Mostre ambos ao dono. Só marque fabricante/OEM quando houver evidência confirmada. A aplicação alcança as fichas da mesma medida, conforme o painel.',fitment,
  (db,data,actor)=>addCatalogCompatibility({productId:data.product_id,vehicleModelId:data.vehicle_model_id,position:data.position,
    isOem:data.is_oem,source:data.source,confidenceLevel:data.confidence_level,yearStart:data.year_start,yearEnd:data.year_end,previousPeriod:data.previous_period,reason:data.reason,actorLabel:actor},undefined,db));
write('catalog','remover_compatibilidade_catalogo','Remove a faixa selecionada. Consulte a ficha, preencha previous_period com os dois limites e apresente os anos ao dono.',compatibilityDeleteParams.merge(compatibilityDeleteBody),
  (db,data,actor)=>removeCatalogCompatibility({productId:data.product_id,vehicleModelId:data.vehicle_model_id,position:data.position,previousPeriod:data.previous_period,reason:data.reason,actorLabel:actor},undefined,db));
const discovery=discoveryBody.innerType().extend(product.shape).superRefine((data,ctx)=>{
  const parsed=discoveryBody.safeParse(data);if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue(issue);
});
write('catalog','registrar_descoberta_catalogo','Registra uma evidência de aplicação para revisão, sem tratar a sugestão como compatibilidade aprovada.',discovery,
  (db,data,actor)=>createCatalogFitmentDiscovery({productId:data.product_id,vehicleModelId:data.vehicle_model_id,position:data.position,
    sourceUrl:data.source_url,sourceTitle:data.source_title,evidenceSummary:data.evidence_summary,suggestedIsOem:data.suggested_is_oem,
    confidenceLevel:data.confidence_level,yearStart:data.year_start,yearEnd:data.year_end,actorLabel:actor},undefined,db));
write('catalog','revisar_descoberta_catalogo','Aprova ou rejeita a descoberta identificada depois da decisão do dono.',discoveryReviewBody.extend({...product.shape,discovery_id:z.string().uuid()}),
  (db,data,actor)=>reviewCatalogFitmentDiscovery({productId:data.product_id,discoveryId:data.discovery_id,decision:data.decision,reason:data.reason,actorLabel:actor},undefined,db));
write('catalog','classificar_referencias_moto','Recupera a categoria Moto de referências originais da medida. Consulte a ficha ou a medida, mostre os modelos e envie somente os application_ids autorizados de referencias_para_classificar. Preserva os anos, a posição e os vínculos do produto.',referenceSelection,
  (db,data,actor)=>classifyMotorcycleReferences(db,data,actor));
read('consultar_ficha_catalogo','Detalha as referências da medida e os vínculos do produto. Se houver referencias_para_classificar, proponha classificar_referencias_moto.',product,async data=>({
  compatibilidades:await getCatalogCompatibility(data.product_id),descobertas:await getCatalogFitmentDiscoveries(data.product_id),
  precos:await getCatalogPriceHistory(data.product_id),precos_atacado:await getCatalogWholesaleHistory(data.product_id)}));
read('buscar_veiculos_catalogo','Busca os identificadores de veículos para compatibilidades.',vehicleSearchQuery,data=>searchCatalogVehicleModels(data.q,undefined,undefined,data.vehicle_type));
read('consultar_aplicacoes_medida','Consulta referências originais da medida e indica quais podem receber a categoria Moto em referencias_para_classificar.',z.object({medida:z.string().min(1).max(60)}).strict(),data=>getCatalogMeasureApplications(data.medida));
