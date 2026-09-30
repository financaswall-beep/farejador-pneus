import { describe, expect, it } from 'vitest';
import { activeOrganicPlatforms, mergeOrganicResults, deliveryViews, type CentralResult } from '../../../src/marketing/organic/results-model.js';
import type { OrganicPublication } from '../../../src/social-comments/publications.js';
import { buildOrganicReport } from '../../../src/marketing/organic/report.js';
import { organicPublicationWindow } from '../../../src/admin/painel/marketing-organic-period.js';

const native=(platform:'instagram'|'facebook',id:string):OrganicPublication=>({platform,id,
  account_id:platform==='instagram'?'200':'100',title:'Mesmo texto',caption:'Pneus',published_at:'2026-09-29T12:00:00Z',
  format:'image',image_url:null,url:null});
const central=(id='post'):CentralResult=>({id,title:'Título interno',caption:'Legenda',status:'partial',version:4,
  scheduled_at:'2026-09-29T12:00:00Z',created_at:'2026-09-28T12:00:00Z',thumbnail_path:null,
  deliveries:[{platform:'instagram',account_id:'200',post_id:'301',format:'feed',status:'published',
    post_url:null,error_code:null,published_at:'2026-09-29T12:00:00Z',views:200,observed_at:null},
  {platform:'facebook',account_id:'100',post_id:'',format:'feed',status:'uncertain',
    post_url:null,error_code:'publisher_confirmation_required',published_at:null,views:null,observed_at:null}]});
describe('Resultados unidos somente por vínculos confirmados',()=>{
  it('não mistura posts diretos com o mesmo texto/data',()=>{
    const rows=mergeOrganicResults([native('instagram','301'),native('facebook','100_302')],[],['instagram','facebook']);
    expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.key)).size).toBe(2);
  });
  it('agrega destinos da Central; um ID incerto não consome outro post',()=>{
    const saved=central();saved.deliveries[1]!.post_id='100_302';
    const rows=mergeOrganicResults([native('instagram','301'),native('facebook','100_302')],[saved],['instagram','facebook']);
    expect(rows).toHaveLength(2);
    expect(rows.find(r=>r.publisher_id)).toMatchObject({title:'Título interno',version:4,status:'partial',views:200});
    expect(rows.find(r=>r.key==='facebook:100_302')).toBeDefined();
  });
  it('consome as duas cópias somente quando ambas foram confirmadas',()=>{
    const saved=central();Object.assign(saved.deliveries[1]!,{status:'published',post_id:'100_302',views:0});
    const rows=mergeOrganicResults([native('instagram','301'),native('facebook','100_302')],[saved],['instagram','facebook']);
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({views:200,views_complete:true});
  });
  it('não inclui redes inativas e distingue zero de total parcial',()=>{
    const saved=central();Object.assign(saved.deliveries[1]!,{status:'published',views:null});
    expect(deliveryViews(saved.deliveries)).toEqual({views:200,views_complete:false});
    expect(deliveryViews([{...saved.deliveries[0]!,views:0}])).toEqual({views:0,views_complete:true});
    expect(mergeOrganicResults([native('facebook','302')],[saved],['instagram'])[0]!.deliveries).toHaveLength(1);
    expect(mergeOrganicResults([native('facebook','302')],[saved],[])).toHaveLength(0);
  });
  it('token ou conta inválida nunca declara integração ativa',()=>{
    const config={enabled:true,publish:true,apiVersion:'v26.0',scopeValid:true,token:'secret',pageId:'100',instagramId:'200'};
    expect(activeOrganicPlatforms(config)).toEqual(['instagram','facebook']);
    expect(activeOrganicPlatforms({...config,scopeValid:false})).toEqual([]);
    expect(activeOrganicPlatforms({...config,token:undefined})).toEqual([]);
  });
  it('uma conversa e um pedido atribuídos a duas redes não multiplicam venda/receita',()=>{
    const time='2026-09-29T12:00:00Z',period=organicPublicationWindow(time,'7d');
    const outreach=[{id:'out-1',status:'sent',sent_at:time},{id:'out-2',status:'sent',sent_at:time}];
    const sources=[{id:'s1',outreach_id:'out-1',conversation_id:'cv',first_reply_at:time},
      {id:'s2',outreach_id:'out-2',conversation_id:'cv',first_reply_at:time}];
    const order={order_id:'order',order_number:1,conversation_id:'cv',amount:99,refunded:0,cancelled:false,
      confirmed_at:time,realized_at:time,first_reply_at:time,commented_at:time,private_sent_at:time};
    const report=buildOrganicReport(period,outreach,sources,[{...order,conversation_source_id:'s1'},{...order,conversation_source_id:'s2'}]);
    expect(report).toMatchObject({conversations:1,converted_conversations:1,sales:1,revenue:99,confirmed_orders:1});
    expect(report.sales_rows).toHaveLength(1);
  });
});
