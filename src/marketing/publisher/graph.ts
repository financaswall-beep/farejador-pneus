import { CommentsGraph, MetaCommentError, safePostUrl } from '../../social-comments/graph.js';
import { commentsConfig, type CommentsConfig } from '../../social-comments/config.js';
import { accountId, type Destination } from './model.js';

export interface Delivery extends Destination {
  account_id:string;container_id:string|null;provider_id:string|null;media_kind:string;
}
function providerId(value:unknown):string {
  if(typeof value!=='string' || !/^[0-9_]+$/.test(value))throw new MetaCommentError('publisher_meta_ack_unknown',true);
  return value;
}
export interface PublishingGraph {
  prepare(d:Delivery,url:string):Promise<string>;
  ready(d:Delivery):Promise<boolean>;
  publish(d:Delivery):Promise<string>;
  verify(d:Delivery):Promise<{confirmed:boolean;url:string|null}>;
}
/** Adapta o cliente Graph existente; somente as duas contas fixadas podem receber conteúdo. */
export class PublisherGraph extends CommentsGraph implements PublishingGraph {
  constructor(private publisherGraphConfig:CommentsConfig=commentsConfig(),private publisherFetch:typeof fetch=fetch) {
    super(publisherGraphConfig,publisherFetch);
  }
  private check(d:Delivery):void {
    if(d.account_id!==accountId(d.platform))throw new MetaCommentError('meta_account_not_allowed');
  }
  async prepare(d:Delivery,url:string):Promise<string> {
    this.check(d);await this.assertAccount(d.platform,d.account_id);
    if(d.platform==='instagram') {
      const params:Record<string,string>=d.media_kind==='photo'?{image_url:url}:{video_url:url};
      if(d.format==='story')params.media_type='STORIES';
      else {params.caption=d.caption??'';if(d.format==='reel'){params.media_type='REELS';params.share_to_feed='true';}}
      return providerId((await this.call(`${d.account_id}/media`,'POST',params)).id);
    }
    if(d.media_kind==='photo')return providerId((await this.call(`${d.account_id}/photos`,'POST',{url,published:'false'})).id);
    const edge=d.format==='story'?'video_stories':'video_reels';
    const container=providerId((await this.call(`${d.account_id}/${edge}`,'POST',{upload_phase:'start'})).video_id);
    // Não seguir upload_url vindo de terceiros. Endpoint e versão fixados localmente.
    let response:Response;
    try {
      response=await this.publisherFetch(`https://rupload.facebook.com/video-upload/${this.publisherGraphConfig.apiVersion}/${container}`,{
        method:'POST',redirect:'error',headers:{Authorization:`OAuth ${this.publisherGraphConfig.token}`,file_url:url},signal:AbortSignal.timeout(30_000)});
    }catch{throw new MetaCommentError('publisher_upload_unknown');}
    const data=await response.json() as {success?:boolean};
    if(!response.ok || data.success!==true)throw new MetaCommentError('publisher_upload_rejected');
    return container;
  }
  async ready(d:Delivery):Promise<boolean> {
    this.check(d);
    if(!d.container_id)throw new MetaCommentError('publisher_container_missing');
    if(d.platform==='instagram') {
      const result=await this.call(d.container_id,'GET',{fields:'status_code'});
      if(['ERROR','EXPIRED'].includes(result.status_code))throw new MetaCommentError('publisher_processing_failed');
      if(result.status_code==='PUBLISHED')throw new MetaCommentError('publisher_already_published',true);
      return result.status_code==='FINISHED';
    }
    if(d.media_kind==='photo')return true;
    const result=await this.call(d.container_id,'GET',{fields:'status'});
    if(result.status?.video_status==='error')throw new MetaCommentError('publisher_processing_failed');
    return result.status?.uploading_phase?.status==='complete';
  }
  async publish(d:Delivery):Promise<string> {
    this.check(d);
    if(!d.container_id)throw new MetaCommentError('publisher_container_missing');
    if(d.platform==='instagram')return providerId((await this.call(`${d.account_id}/media_publish`,'POST',{creation_id:d.container_id})).id);
    if(d.media_kind==='photo') {
      const result=await this.call(`${d.account_id}/${d.format==='story'?'photo_stories':'feed'}`,'POST',d.format==='story'
        ? {photo_id:d.container_id}:{message:d.caption??'',attached_media:JSON.stringify([{media_fbid:d.container_id}]),published:'true'});
      if(d.format==='story' && result.success===true)return typeof result.post_id==='string'?providerId(result.post_id):d.container_id;
      return providerId(result.post_id??result.id);
    }
    const result=await this.call(`${d.account_id}/${d.format==='story'?'video_stories':'video_reels'}`,'POST',{
      upload_phase:'finish',video_id:d.container_id,video_state:'PUBLISHED',...(d.format==='reel'?{description:d.caption??''}:{})});
    if(result.success!==true)throw new MetaCommentError('publisher_meta_ack_unknown',true);
    return d.container_id;
  }
  async verify(d:Delivery):Promise<{confirmed:boolean;url:string|null}> {
    this.check(d);
    if(!d.provider_id)throw new MetaCommentError('publisher_provider_missing');
    if(d.platform==='instagram') {
      const result=await this.call(d.provider_id,'GET',{fields:d.format==='story'?'id,timestamp':'id,timestamp,permalink'});
      return {confirmed:result.id===d.provider_id && typeof result.timestamp==='string',url:safePostUrl(result.permalink)};
    }
    if(d.format==='story') {
      const result=await this.call(`${d.account_id}/stories`,'GET',{fields:'id,media_id,post_id,status,url',limit:'100'});
      const story=Array.isArray(result.data)?result.data.find((s:Record<string,unknown>)=>
        [s.id,s.media_id,s.post_id].some(v=>String(v)===d.provider_id || String(v)===d.container_id)):undefined;
      return {confirmed:story?.status==='PUBLISHED',url:safePostUrl(story?.url)};
    }
    if(d.media_kind==='video') {
      const result=await this.call(d.provider_id,'GET',{fields:'status,permalink_url'});
      return {confirmed:result.status?.publishing_phase?.status==='complete',url:safePostUrl(result.permalink_url)};
    }
    const result=await this.call(d.provider_id,'GET',{fields:'id,is_published,permalink_url'});
    return {confirmed:result.id===d.provider_id && result.is_published===true,url:safePostUrl(result.permalink_url)};
  }
  async connections() {
    return Promise.all((['facebook','instagram'] as const).map(async platform=>{
      try {await this.assertAccount(platform,accountId(platform));return {platform,verified:true};}
      catch{return {platform,verified:false};}
    }));
  }
}
