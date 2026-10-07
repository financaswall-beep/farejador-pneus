import { randomUUID } from 'node:crypto';
import type { PoolClient,Pool } from 'pg';
import sharp from 'sharp';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture,type PartnerFixture } from './helpers/partner-fixtures.js';
import type { TirePhotoStorage } from '../../src/photos/storage.js';

let db:IntegrationDb,client:PoolClient,own:PartnerFixture,other:PartnerFixture,jpeg:Buffer;
let processUpload:typeof import('../../src/photos/process.js')['processPhotoUpload'];
let purge:typeof import('../../src/photos/retention.js')['purgeOneClosedPhotoRequest'];
let migrate:typeof import('../../src/photos/process.js')['migrateOnePhoto'];
let reserve:typeof import('../../src/photos/uploads.js')['reservePhotoUpload'];
let complete:typeof import('../../src/photos/uploads.js')['completePhotoUpload'];
let pools:Pool[]=[];
const objects=new Map<string,Buffer>();
const storage={ read:async(p:string)=>{const b=objects.get(p);if(!b)throw Error('storage_missing');return b;},
  put:async(p:string,b:Buffer)=>{objects.set(p,b);}, remove:async(paths:string[])=>{paths.forEach(p=>objects.delete(p));} } as TirePhotoStorage;

beforeAll(async()=>{
  db=await startPostgres();
  const restrictedUrl=new URL(db.connectionString);restrictedUrl.username='farejador_partner_app';restrictedUrl.password='test';
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:restrictedUrl.toString(),CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',
    PHOTO_REQUESTS:'true',BOT_OUTBOX:'true',AGENT_V2_CONVERSATION_IDS:'*',
    SUPABASE_STORAGE_URL:'https://photos.example.test',SUPABASE_STORAGE_SERVICE_KEY:'test' });
  ({processPhotoUpload:processUpload,migrateOnePhoto:migrate}=await import('../../src/photos/process.js'));
  ({purgeOneClosedPhotoRequest:purge}=await import('../../src/photos/retention.js'));
  ({reservePhotoUpload:reserve,completePhotoUpload:complete}=await import('../../src/photos/uploads.js'));
  pools=[(await import('../../src/persistence/db.js')).pool,(await import('../../src/parceiro/db.js')).partnerPool];
  own=await createPartnerFixture(db.pool);other=await createPartnerFixture(db.pool);
  jpeg=await sharp({create:{width:1600,height:800,channels:3,background:'#234567'}}).jpeg().toBuffer();
  client=await db.pool.connect();
},180000);
afterAll(async()=>{client?.release();for(const p of pools)await p.end();if(db)await stopPostgres(db);});
beforeEach(async()=>{objects.clear();await client.query('BEGIN');});
afterEach(async()=>{await client.query('ROLLBACK');vi.unstubAllGlobals();});
async function photo(age='3 days',status='resolved',unit=own.unitId,environment='test') {
  const cw=Date.now()+Math.floor(Math.random()*1000000);
  const cv=(await client.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    current_status,started_at,resolved_at) VALUES($1,$2,1,$3,now()-$4::interval,now()-$4::interval) RETURNING id`,
    [environment,cw,status,age])).rows[0].id;
  const id=(await client.query(`INSERT INTO commerce.photo_requests(environment,unit_id,conversation_id,tire_size,
    status,created_at,answered_at,expires_at) VALUES($1,$2,$3,'90/90-18','answered',now()-$4::interval,
    now()-$4::interval,now()-$4::interval) RETURNING id`,[environment,unit,cw,age])).rows[0].id;
  const blob=(await client.query(`INSERT INTO commerce.photo_request_blobs
    (environment,unit_id,photo_request_id,photo_bytes,photo_mime,photo_size_bytes)
    VALUES($1,$2,$3,$4,'image/jpeg',$5) RETURNING id`,[environment,unit,id,jpeg,jpeg.length])).rows[0].id;
  return {id,blob,cv,cw};
}
describe('Storage e retenção operacional de fotos',()=>{
  it('retém atendimentos abertos e encerrados há menos de 48h; elimina só os bytes vencidos',async()=>{
    const old=await photo(),active=await photo('4 days','open'),recent=await photo('47 hours');
    expect(await purge(client,'test',storage)).toBe(true);
    const rows=(await client.query('SELECT photo_request_id,photo_bytes,deleted_at,photo_size_bytes FROM commerce.photo_request_blobs')).rows;
    expect(rows.find(r=>r.photo_request_id===old.id)).toMatchObject({photo_bytes:null,photo_size_bytes:jpeg.length});
    expect(rows.find(r=>r.photo_request_id===old.id).deleted_at).not.toBeNull();
    for(const id of [active.id,recent.id]) expect(rows.find(r=>r.photo_request_id===id).photo_bytes).toEqual(jpeg);
    expect(await purge(client,'test',storage)).toBe(false);
    expect((await client.query(`SELECT count(*)::int AS n FROM audit.events WHERE event_type='tire_photos_purged'`)).rows[0].n).toBe(1);
  });
  it('envio pendente ou ambíguo protege a imagem; entrega confirmada permite limpeza',async()=>{
    const pr=await photo();
    await client.query(`INSERT INTO ops.outbound_messages(environment,conversation_id,chatwoot_conversation_id,kind,body,body_sha256,status)
      VALUES('test',$1,$2,'photo_attachment',$3,'hash','dead_letter')`,[pr.cv,pr.cw,JSON.stringify({photo_request_id:pr.id})]);
    expect(await purge(client,'test',storage)).toBe(false);
    await client.query(`UPDATE ops.outbound_messages SET status='delivered' WHERE conversation_id=$1`,[pr.cv]);
    expect(await purge(client,'test',storage)).toBe(true);
  });
  it.each(['pickup','delivery'])('conversa resolvida não elimina imagem de pedido ativo: %s',async mode=>{
    const pr=await photo();
    const order=(await client.query(`INSERT INTO commerce.partner_orders(environment,unit_id,total_amount,status,
      fulfillment_mode,awaiting_pickup) VALUES('test',$1,100,'paid',$2,$3) RETURNING id`,[own.unitId,mode,mode==='pickup'])).rows[0].id;
    const item=(await client.query(`INSERT INTO commerce.partner_order_items(environment,order_id,partner_stock_id,item_name,quantity,unit_price)
      VALUES('test',$1,$2,'90/90-18',1,100) RETURNING id`,[order,own.stockId])).rows[0].id;
    await client.query('UPDATE commerce.photo_requests SET order_item_id=$2 WHERE id=$1',[pr.id,item]);
    expect(await purge(client,'test',storage)).toBe(false);
    await client.query(`UPDATE commerce.partner_orders SET awaiting_pickup=false,retrieved_at=now()-interval '3 days',
      delivered_at=now()-interval '3 days',status='delivered' WHERE id=$1`,[order]);
    await client.query(`UPDATE core.conversations SET current_status='open' WHERE id=$1`,[pr.cv]);
    expect(await purge(client,'test',storage)).toBe(false);
    await client.query(`UPDATE core.conversations SET current_status='resolved',resolved_at=now() WHERE id=$1`,[pr.cv]);
    expect(await purge(client,'test',storage)).toBe(false);
    await client.query(`UPDATE core.conversations SET resolved_at=now()-interval '3 days' WHERE id=$1`,[pr.cv]);
    expect(await purge(client,'test',storage)).toBe(true);
  });
  it('upload validado mantém pneu/arquivo, enfileira todos os ângulos e migra BYTEA sem perder leitura',async()=>{
    const pr=await photo('1 hour','open');
    const uploadId=randomUUID(),prefix=`test/${own.unitId}/${pr.id}/${uploadId}`;
    objects.set(prefix+'/upload.jpg',jpeg);
    await client.query(`INSERT INTO commerce.photo_uploads(id,environment,unit_id,photo_request_id,state)
      VALUES($1,'test',$2,$3,'queued')`,[uploadId,own.unitId,pr.id]);
    expect(await processUpload(client,'test',storage)).toBe(true);
    expect(await processUpload(client,'test',storage)).toBe(false);
    const row=(await client.query('SELECT * FROM commerce.photo_request_blobs WHERE id=$1',[uploadId])).rows[0];
    expect(row.photo_bytes).toBeNull();expect(row.storage_path).toBe(prefix+'/photo.webp');
    expect((await sharp(objects.get(row.storage_path)!).metadata()).width).toBe(1200);
    const outbound=(await client.query('SELECT body,echo_id FROM ops.outbound_messages WHERE conversation_id=$1',[pr.cv])).rows[0];
    expect(JSON.parse(outbound.body)).toMatchObject({photo_blob_id:uploadId,photo_request_id:pr.id});
    expect(outbound.echo_id).toBe('photo:'+uploadId);
    expect(await migrate(client,'test',storage)).toBe(true);
    expect((await client.query('SELECT photo_bytes,storage_path FROM commerce.photo_request_blobs WHERE id=$1',[pr.blob])).rows[0].photo_bytes).toBeNull();
  });
  it('falha no Storage conserva o arquivo/referência; nunca aceita HTML como foto',async()=>{
    const pr=await photo('1 hour','open'),id=randomUUID();
    await client.query(`INSERT INTO commerce.photo_uploads(id,environment,unit_id,photo_request_id,state)
      VALUES($1,'test',$2,$3,'queued')`,[id,own.unitId,pr.id]);
    objects.set(`test/${own.unitId}/${pr.id}/${id}/upload.jpg`,Buffer.from('<html>no</html>'));
    expect(await processUpload(client,'test',storage)).toBe(true);
    expect((await client.query('SELECT state FROM commerce.photo_uploads WHERE id=$1',[id])).rows[0].state).toBe('rejected');
    const storageFailure={...storage,put:async()=>{throw Error('offline');}} as TirePhotoStorage;
    await expect(migrate(client,'test',storageFailure)).rejects.toThrow('offline');
    expect((await client.query('SELECT photo_bytes FROM commerce.photo_request_blobs WHERE id=$1',[pr.blob])).rows[0].photo_bytes).toEqual(jpeg);
  });
  it('nega pedido de outro parceiro antes de usar Storage e preserva separação de ambientes',async()=>{
    const pr=await photo();
    const prodUnit=(await client.query(`INSERT INTO core.units(environment,slug,name) VALUES('prod',$1,'Prod') RETURNING id`,[randomUUID()])).rows[0].id;
    const prod=await photo('3 days','resolved',prodUnit,'prod');
    await purge(client,'test',storage);
    expect((await client.query('SELECT photo_bytes FROM commerce.photo_request_blobs WHERE id=$1',[prod.blob])).rows[0].photo_bytes).toEqual(jpeg);
  });
  it('reserva no máximo três arquivos simultâneos, retry usa o mesmo UUID, e outro parceiro não obtém URL',async()=>{
    const request=(await db.pool.query(`INSERT INTO commerce.photo_requests(environment,unit_id,conversation_id,tire_size)
      VALUES('test',$1,-100,'90/90-18') RETURNING id`,[own.unitId])).rows[0].id;
    const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify({url:new URL(url).pathname.replace('/storage/v1','')+'?token=test'}),
      {status:200,headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    try {
      await expect(reserve(other.ctx,request,randomUUID())).rejects.toMatchObject({status:404});
      await expect(complete(other.ctx,request,randomUUID())).rejects.toMatchObject({status:404});
      expect(fetcher).not.toHaveBeenCalled();
      const ids=Array.from({length:4},()=>randomUUID());
      const results=await Promise.allSettled(ids.map(id=>reserve(own.ctx,request,id)));
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
      expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
      const accepted=(await db.pool.query('SELECT id FROM commerce.photo_uploads WHERE photo_request_id=$1 LIMIT 1',[request])).rows[0].id;
      await reserve(own.ctx,request,accepted);
      expect((await db.pool.query('SELECT count(*)::int AS n FROM commerce.photo_uploads WHERE photo_request_id=$1',[request])).rows[0].n).toBe(3);
      expect(await complete(own.ctx,request,accepted)).toMatchObject({state:'queued'});
      expect(await complete(own.ctx,request,accepted)).toMatchObject({state:'queued'});
    } finally {
      await db.pool.query('DELETE FROM commerce.photo_uploads WHERE photo_request_id=$1',[request]);
      await db.pool.query('DELETE FROM commerce.photo_requests WHERE id=$1',[request]);
    }
  });
});
