(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch(_){return '';}}
  function notices(data,inboxId){
    if(!data)return [];
    const items=(data.channels||[]).filter(c=>inboxId==null||Number(c.inbox_id)===Number(inboxId));
    const result=items.filter(c=>c.authorization!=='no_reauthorization_required').map(c=>{
      const name=c.channel==='instagram'?'Instagram':'Facebook',disconnected=c.authorization==='reauthorization_required';
      return {id:c.inbox_id,disconnected,title:disconnected?name+' desconectado':name+': conexão não confirmada',
        text:data.status!=='ok'?'Último aviso registrado. Não foi possível consultar o estado atual.'
          :disconnected?'A autorização precisa ser renovada no Chatwoot.'
          :'O Chatwoot não informou o estado da autorização. Confira a conexão na caixa.',
        url:safeUrl(c.reconnect_url),action:disconnected?'Reconectar '+name:'Ver '+name+' no Chatwoot'};
    });
    if(data.status!=='ok'&&inboxId==null)result.unshift({id:'unavailable',disconnected:false,
      title:'Verificação dos canais indisponível',text:data.status==='not_configured'
        ?'Peça ao administrador para conferir a integração com o Chatwoot.'
        :'Não foi possível verificar Instagram e Facebook agora. Tentaremos novamente automaticamente.',url:''});
    return result;
  }
  function render(element,data,inboxId){
    if(!element)return;
    const items=notices(data,inboxId);
    const html=items.map(item=>`<section class="channel-alert ${item.disconnected?'disconnected':'unavailable'}"><span>${escape(item.title)}</span>${item.url?`<a href="${escape(item.url)}" aria-label="${escape(item.action)}" target="_blank" rel="noopener noreferrer">${item.disconnected?'Reconectar':'Ver conexão'}</a>`:''}${!item.disconnected||data.status!=='ok'?`<small>${escape(item.text)}</small>`:''}</section>`).join('');
    if(element._channelAlertsHtml!==html){element.innerHTML=html;element._channelAlertsHtml=html;}
    element.hidden=!items.length;
  }
  function create(options){
    let data=null,session='',nextCheck=0,sequence=0,pending=null;
    const draw=()=>options.targets().forEach(target=>render(target.element,data,target.inboxId));
    const reset=()=>{sequence++;pending=null;data=null;session='';nextCheck=0;draw();};
    async function refresh(force){
      if(!options.active())return;
      const identity=options.session();if(identity!==session){reset();session=identity;}
      if(pending)return pending;
      if(!force&&Date.now()<nextCheck){draw();return;}
      const seq=++sequence;
      const task=(async()=>{
        try{const result=await options.request();if(seq!==sequence||identity!==options.session()||!options.active())return;data=result;}
        catch(_){if(seq!==sequence||identity!==options.session()||!options.active())return;
          data={...(data||{channels:[],checked_at:null}),status:'unavailable'};}
        finally{if(seq===sequence){pending=null;nextCheck=Date.now()+(data?.status==='ok'?30000:15000);if(options.active())draw();}}
      })();pending=task;return task;
    }
    return {refresh,render:draw,reset,stop:()=>{sequence++;pending=null;nextCheck=0;}};
  }
  window.FarejadorChannelAlerts={create,render,notices};
}());
