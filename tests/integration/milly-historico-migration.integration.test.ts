import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { registrarParecerMilly } from '../../src/atendente-v2/milly-negociacao.js';
import { registrarLeituraFichaMilly } from '../../src/admin/dot/events/negotiation-live-snapshot.js';

let db: IntegrationDb;
beforeAll(async () => {
  db = await startPostgres({throughMigration:'0296_milly_consulta_comercial.sql'});
}, 240000);
afterAll(async () => { if (db) await stopPostgres(db); });

it('preserva negociações anteriores e registra somente os fatos conhecidos a partir da 0297', async () => {
  const row = (await db.pool.query(`WITH dono AS (
    INSERT INTO network.partner_people(environment,username,password_hash) VALUES ('test','dono-historico','fixture') RETURNING id
  ), gate AS (
    INSERT INTO ops.milly_consulta_config(environment,enabled,owner_person_id) SELECT 'test',true,id FROM dono
    RETURNING owner_person_id,generation
  ), contato AS (
    INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES ('test',901) RETURNING id
  ), conversa AS (
    INSERT INTO core.conversations(environment,chatwoot_conversation_id,contact_id,chatwoot_account_id,current_status,started_at)
      SELECT 'test',901,id,1,'open',now() FROM contato RETURNING id,contact_id
  ), loja AS (
    INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz')
      ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id
  ), produto AS (
    INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES ('test','HIST-097','Pneu de teste','tire') RETURNING id
  ) SELECT owner_person_id,generation,conversa.id AS conversa,contact_id,loja.id AS loja,produto.id AS produto
    FROM gate,conversa,loja,produto`)).rows[0]!;
  const nova = async () => (await db.pool.query(`INSERT INTO ops.milly_consultas
    (environment,generation,conversation_id,trigger_message_id,unit_id,product_id,quantity,payment_method,
      fulfillment_mode,offered_total_cents,catalog_unit_cents,freight_cents)
    VALUES ('test',$1,$2,$3,$4,$5,1,'pix','pickup',8000,11000,0) RETURNING id`,
  [row.generation,row.conversa,randomUUID(),row.loja,row.produto])).rows[0]!.id as string;
  const owner = row.owner_person_id;
  const facts = {
    medida:'110/70-13',marca:'Teste',condicao:'novo',disponivel:2,reservado:0,
    estoque_vendavel:true,motivo_estoque:null,custo_unitario_centavos:5000,
    custo_produtos_para_quantidade_centavos:5000,tabela_atual_centavos:11000,
    vendas_liquidas_30_dias:4,entradas_previstas:0,data_reposicao_confirmada:null,
    cobertura_estimada_dias:15,rota_compativel_confirmada:null,custo_incremental_entrega_centavos:0,rotas:null,
  };
  const old = await nova();
  expect(await registrarLeituraFichaMilly(db.pool,'test',old,owner,facts)).toBeInstanceOf(Date);
  expect(await registrarParecerMilly(db.pool,'test',old,{decisao:'manter',personId:owner,justificativa:'Manter tabela.'})).toBe(true);

  await applyMigrationFile(db.pool,'0297_milly_historico_consultas.sql');
  const saved = async (id:string) => (await db.pool.query(`SELECT context_read_at,context_snapshot,decided_at,decision_rationale
    FROM ops.milly_consultas WHERE environment='test' AND id=$1`,[id])).rows[0];
  expect(await saved(old)).toEqual({context_read_at:null,context_snapshot:null,decided_at:null,decision_rationale:null});

  const current = await nova();
  expect(await registrarLeituraFichaMilly(db.pool,'test',current,randomUUID(),facts)).toBeNull();
  const read = await registrarLeituraFichaMilly(db.pool,'test',current,owner,{...facts,endereco:'ignorado',transcricao:'ignorada'});
  expect(read).toBeInstanceOf(Date);
  expect(await registrarParecerMilly(db.pool,'test',current,{decisao:'contrapropor',totalCentavos:10500,personId:owner})).toBe(true);
  expect(await registrarLeituraFichaMilly(db.pool,'test',current,owner,{...facts,disponivel:1})).toBeNull();
  expect(await saved(current)).toEqual({context_read_at:read,context_snapshot:facts,decided_at:expect.any(Date),decision_rationale:null});
  const declined = await nova();
  expect(await registrarParecerMilly(db.pool,'test',declined,{decisao:'manter',personId:owner})).toBe(true);
  expect(await saved(declined)).toEqual({context_read_at:null,context_snapshot:null,decided_at:expect.any(Date),decision_rationale:null});

  await db.pool.query("SELECT ops.anonymize_contact($1,'titular','teste')",[row.contact_id]);
  expect(await saved(current)).toBeUndefined();
});
