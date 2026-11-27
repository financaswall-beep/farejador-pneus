import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import { createCatalogCarModel, saveCarMeasureApplications } from '../painel/catalog-car-registration.js';
import { carImpact, correctCarModel, correctCarReferences, findCarApplications, setCarStatus,
  setReferenceStatus } from '../painel/catalog-car-management.js';
import { carModelBody, carReferenceBody } from '../painel/route-catalogo-carros.js';
import { registerInventoryRead as read, registerInventoryWrite as write } from './inventory-registry.js';

const id = z.string().uuid();
const reason = z.string().trim().min(2).max(500);
const ids = z.array(z.string().trim().min(1).max(300)).min(1).max(2)
  .refine(values => new Set(values).size === values.length, 'Selecione cada referência uma única vez.');
const name = z.string().trim().min(1).max(100).transform(value => value.replace(/\s+/g,' '));
const status = z.enum(['ativo','arquivado']);
const validPeriod = (value: {year_start: number; year_end: number}) => value.year_start <= value.year_end;

read('consultar_aplicacoes_veiculo',
  'Consulte todas as versões de um modelo de carro, as medidas técnicas, os eixos, as fontes e os anos, inclusive sem produto ou estoque. Use model como nome exato da família (Hilux) e variant separado (SRX). Inclua arquivadas para localizar uma referência ou reativar um cadastro.',
  z.object({model:name, make:name.optional(), variant:name.optional(), year:z.number().int().min(1900).max(2100).optional(),
    include_archived:z.boolean().optional()}).strict(), data => findCarApplications(pool,env.FAREJADOR_ENV,data));

function previewVehicle(db: PoolClient, data: {vehicle_model_id: string}) {
  return carImpact(db,env.FAREJADOR_ENV,data.vehicle_model_id);
}

async function previewReference(db: PoolClient, data: z.output<typeof carReferenceBody>) {
  const impact = await previewVehicle(db,data);
  const size = applicationMeasureKey(data.tire_size);
  const affected = impact.references.filter(row=>row.status==='verified'
    && (data.position==='both' || data.position===row.position)
    && data.year_start <= (row.year_end ?? 2100) && data.year_end >= (row.year_start ?? 1900));
  return {vehicle:impact.vehicle,referencias_no_mesmo_eixo_e_periodo:affected,
    medidas_distintas_para_revisar:affected.filter(row=>row.display_measure!==size).map(row=>row.application_id)};
}

write('catalog','cadastrar_veiculo_catalogo',
  'Cadastra um carro por marca, modelo, versão e período. Para um único ano repita o ano nos dois campos. Reutiliza o cadastro exato e verifica sobreposição da mesma versão.',
  carModelBody,(db,data,actor)=>createCatalogCarModel(db,env.FAREJADOR_ENV,data,actor));

write('catalog','corrigir_veiculo_catalogo',
  'Corrige a identidade completa de um carro. Informe os campos finais, inclusive variant=null quando genérico. Ao mudar o nome ou versão, informe em aliases os apelidos válidos para o novo cadastro; os anteriores serão removidos. Apresente os vínculos de produtos e referências afetados.',
  carModelBody.innerType().extend({vehicle_model_id:id, reason}).strict().refine(validPeriod),
  (db,data,actor)=>correctCarModel(db,env.FAREJADOR_ENV,data.vehicle_model_id,data,data.reason,actor),false,previewVehicle);

write('catalog','definir_status_veiculo_catalogo',
  'Arquiva ou reativa um carro. O arquivamento retira a versão e suas referências das consultas comerciais; a reativação recupera apenas as referências suspensas com o carro. Apresente os vínculos existentes.',
  z.object({vehicle_model_id:id,status,reason}).strict(),
  (db,data,actor)=>setCarStatus(db,env.FAREJADOR_ENV,data.vehicle_model_id,data.status==='ativo',data.reason,actor),false,previewVehicle);

write('catalog','cadastrar_referencia_veiculo',
  'Cadastra a medida técnica original de uma versão de carro, por período e eixo, mesmo sem SKU ou estoque. Use a fonte do fabricante quando conferida. Examine as referências já cadastradas em caso de medidas alternativas. O vínculo de um produto se faz em salvar_compatibilidade_catalogo.',
  carReferenceBody,(db,data,actor)=>saveCarMeasureApplications(db,env.FAREJADOR_ENV,data,actor),false,previewReference);

write('catalog','corrigir_referencia_veiculo',
  'Corrige medida, anos, eixo, fonte ou índice da referência técnica deste carro. Envie todos os campos finais e os IDs originais retornados na consulta; selecione os dois eixos quando ambos precisarem da correção.',
  carReferenceBody.innerType().extend({previous_application_ids:ids,reason}).strict().refine(validPeriod),
  (db,data,actor)=>correctCarReferences(db,env.FAREJADOR_ENV,data.previous_application_ids,data,data.reason,actor),false,previewVehicle);

write('catalog','definir_status_referencia_veiculo',
  'Arquiva ou reativa os eixos selecionados de uma referência técnica do carro, com o motivo e os IDs da consulta. Consulte com include_archived para localizar uma referência arquivada.',
  z.object({vehicle_model_id:id, application_ids:ids,status,reason}).strict(),
  (db,data,actor)=>setReferenceStatus(db,env.FAREJADOR_ENV,data.vehicle_model_id,data.application_ids,
    data.status==='ativo',data.reason,actor),false,previewVehicle);
