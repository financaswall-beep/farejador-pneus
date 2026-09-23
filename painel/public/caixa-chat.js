(function () {
  'use strict';
  const C=window.Caixa, chat=C.chat={};
  const s=chat.state={active:false,id:null,rows:[],detail:null,messages:new Map(),pending:new Map(),drafts:new Map(),avatars:new Map(),avatarExpiry:new Map(),avatarJobs:new Map(),
    filter:'needs',channel:'',search:'',closed:false,offset:0,hasMore:false,next:null,generation:0,listSeq:0,threadSeq:0,
    session:'',loading:false,error:'',threadError:'',connected:false,sending:false,stream:null,poll:0,retry:0,controls:new Map()};
  chat.el=id=>document.getElementById('chat-'+id);
  chat.path=id=>'/api/caixa/chat/conversations'+(id?'/'+encodeURIComponent(id):'');
  chat.api=async function(path,options){
    const response=await C.authenticatedFetch(path,Object.assign({signal:AbortSignal.timeout(20000)},options));
    const data=await C.json(response);
    if(!response.ok){const error=new Error(data.error||'chat_unavailable');error.status=response.status;throw error;}
    return data;
  };
  chat.errorText=error=>({chat_migration_required:'Conversas aguarda a atualização do banco. As outras telas continuam disponíveis.',
    forbidden:'Seu acesso não permite abrir as conversas.',chat_delivery_disabled:'O envio está desativado na configuração do servidor.',
    chat_photo_conflict:'Esse pedido de foto já foi atendido ou expirou. Atualize a conversa.',
    chat_retry_conflict:'O envio ainda precisa de confirmação. Não vou repetir para evitar duas mensagens.',
    bot_control_conflict:'Outra pessoa alterou o atendimento. A conversa foi atualizada.',
    chat_media_invalid:'Arquivo não aceito. Use foto, áudio, vídeo MP4 ou PDF de até 16 MB.',
    rate_limited:'Muitos envios em sequência. Aguarde um pouco e tente novamente.'}[error.message]||'Não consegui atualizar. Confira sua conexão e tente novamente.');
  chat.render=()=>{};
  chat.renderThread=()=>{};
  chat.renderQueue=()=>{};
  chat.reset=function(){
    chat.stop();if(chat.resetMedia)chat.resetMedia();s.session='';s.id=null;s.detail=null;s.rows=[];chat.channels?.reset();
    s.pending.forEach(m=>{if(m.preview)URL.revokeObjectURL(m.preview);});
    s.drafts.clear();s.pending.clear();s.messages.clear();s.avatars.clear();s.avatarExpiry.clear();s.avatarJobs.clear();s.controls.clear();
    s.sending=false;s.listBusy=false;s.threadBusy=false;s.listSeq++;s.threadSeq++;s.filter='needs';s.search='';s.channel='';s.closed=false;
    chat.el('panel')?.classList.add('hidden');chat.el('sheet')?.close();document.body.classList.remove('chat-open');
    if(chat.el('input'))chat.el('input').value='';
  };
  chat.start=function(){
    const session=C.sessionFingerprint();if(s.session!==session){chat.reset();s.session=session;}
    if(s.active)return;s.active=true;s.generation++;
    void chat.loadList();if(s.id)void chat.loadThread();void chat.connect(s.generation);void chat.channels?.refresh(true);
    s.poll=setInterval(()=>{if(document.hidden)return;void chat.loadList();if(s.id)void chat.loadThread();void chat.channels?.refresh();},5000);
  };
  chat.stop=function(){s.active=false;s.generation++;clearInterval(s.poll);clearTimeout(s.retry);chat.channels?.stop();
    if(s.stream)s.stream.abort();s.stream=null;s.connected=false;s.listBusy=false;s.threadBusy=false;s.listSeq++;s.threadSeq++;};
  chat.syncTab=function(tab){
    const active=tab==='conversations';chat.el('panel').classList.toggle('hidden',!active);
    document.getElementById('nav-conversations').classList.toggle('active',active);
    document.getElementById('nav-conversations').setAttribute('aria-current',active?'page':'false');
    C.elements.sessionView.classList.toggle('is-chat',active);
    document.body.classList.toggle('chat-open',active&&!!s.id);
    if(active){C.elements.appHeadingTitle.textContent='Conversas';chat.start();chat.el('panel').classList.remove('hidden');chat.render();}
    else {chat.stop();if(chat.resetMedia)chat.resetMedia();if(location.hash==='#conversas')history.replaceState(null,'',location.pathname+location.search);}
  };
  chat.loadList=async function(append){
    if(!s.active||s.listBusy)return;
    const seq=++s.listSeq,generation=s.generation;
    s.listBusy=true;
    const q=new URLSearchParams({search:s.search,filter:s.filter,channel:s.channel,closed:String(s.closed),offset:String(append?s.offset:0)});
    try{
      const data=await chat.api(chat.path()+'?'+q);
      while(!append&&data.has_more&&data.rows.length<s.offset){
        if(seq!==s.listSeq||generation!==s.generation)return;q.set('offset',String(data.rows.length));
        const page=await chat.api(chat.path()+'?'+q);data.rows.push(...page.rows);data.has_more=page.has_more;
      }
      if(seq!==s.listSeq||generation!==s.generation)return;
      const previous=new Map(s.rows.map(row=>[row.id,row]));
      // Atualizações em segundo plano preservam as páginas que o atendente já abriu.
      s.rows=append?[...new Map([...s.rows,...data.rows].map(r=>[r.id,r])).values()]:data.rows;
      s.offset=s.rows.length;s.hasMore=data.has_more;
      s.total=data.total;s.needsTotal=data.needs_total;s.error='';
      const photo=data.rows.find(row=>row.id!==s.id&&row.photo_request_id&&!previous.get(row.id)?.photo_request_id);
      if(photo&&s.id&&previous.size)chat.photoNotice(photo);
      chat.renderQueue();
    }catch(error){if(generation===s.generation){s.error=chat.errorText(error);chat.renderQueue();}}
    finally{if(seq===s.listSeq)s.listBusy=false;}
  };
  chat.changeFilter=function(){s.rows=[];s.offset=0;s.listSeq++;s.listBusy=false;void chat.loadList();};
  chat.open=function(id){
    if(s.id===id)return;
    if(s.id)s.drafts.set(s.id,chat.el('input').value);
    if(chat.resetMedia)chat.resetMedia();s.id=id;s.detail=null;s.next=null;s.messages.clear();s.threadError='';s.threadSeq++;s.threadBusy=false;
    chat.el('input').value=s.drafts.get(id)||'';document.body.classList.add('chat-open');
    chat.renderThread();chat.renderQueue();void chat.loadThread();void chat.loadAvatar(id);
  };
  chat.back=function(){
    if(s.id)s.drafts.set(s.id,chat.el('input').value);s.id=null;s.threadSeq++;s.threadBusy=false;s.detail=null;s.messages.clear();
    if(chat.resetMedia)chat.resetMedia();document.body.classList.remove('chat-open');chat.render();
  };
  chat.loadThread=async function(older){
    if(!s.id||(!older&&s.threadBusy))return;
    const id=s.id,generation=s.generation,seq=++s.threadSeq;s.threadBusy=true;
    const cursor=older&&s.next?'?'+new URLSearchParams({at:s.next.at,before:s.next.id}):'';
    try{
      const [messages,detail]=await Promise.all([chat.api(chat.path(id)+'/messages'+cursor),older?Promise.resolve(s.detail):chat.api(chat.path(id))]);
      if(id!==s.id||seq!==s.threadSeq||generation!==s.generation)return;
      if(s.detail&&Number(s.detail.version)>Number(detail.version))Object.assign(detail,{mode:s.detail.mode,version:s.detail.version});
      s.detail=detail;s.threadError='';if(older||!s.next)s.next=messages.next;
      messages.messages.forEach(m=>{s.messages.set(m.id,m);if(m.client_token){const old=s.pending.get(m.client_token);if(old?.preview)URL.revokeObjectURL(old.preview);s.pending.delete(m.client_token);}});
      messages.outgoing.forEach(m=>{
        const local=s.pending.get(m.client_token);s.pending.set(m.client_token,Object.assign({},local,m,{conversation_id:id,local:false,request:undefined}));
      });
      chat.renderThread();
    }catch(error){if(id===s.id&&generation===s.generation){s.threadError=chat.errorText(error);chat.renderThread();}}
    finally{if(seq===s.threadSeq)s.threadBusy=false;}
  };
  chat.loadQueueAvatars=function(){if(s.active)[...new Set([s.id,...s.rows.map(row=>row.id)].filter(Boolean))].forEach(id=>void chat.loadAvatar(id));};
  chat.loadAvatar=function(id){
    if(s.avatarJobs.has(id))return s.avatarJobs.get(id);
    if((s.avatarExpiry.get(id)||0)>Date.now()||s.avatarJobs.size>=4)return;
    const session=s.session,task=(async()=>{
      try{const data=await chat.api(chat.path(id)+'/avatar');if(session!==s.session)return;
        const url=chat.safeUrl(data.url);s.avatars.set(id,url||null);s.avatarExpiry.set(id,Date.now()+(url?300000:60000));
      }catch(_){if(session===s.session)s.avatarExpiry.set(id,Date.now()+30000);}
      finally{if(s.avatarJobs.get(id)===task){s.avatarJobs.delete(id);chat.updateAvatars?.(id);chat.loadQueueAvatars();}}
    })();s.avatarJobs.set(id,task);return task;
  };
  chat.avatarFailed=function(id,url){
    if(s.avatars.get(id)!==url)return;s.avatars.set(id,null);s.avatarExpiry.set(id,Date.now()+60000);chat.updateAvatars?.(id);
  };
  chat.refreshAvatars=function(){s.avatarExpiry.clear();chat.loadQueueAvatars();};
  chat.setControl=async function(id,action){
    if(s.controls.has(id)){await s.controls.get(id);return chat.setControl(id,action);}
    const row=id===s.id?s.detail:s.rows.find(r=>r.id===id);if(!row)return;
    if((action==='takeover'&&row.mode==='human')||(action==='resume'&&row.mode==='auto'))return;
    const session=s.session,task=(async()=>{
      try{const result=await chat.api(chat.path(id)+'/control',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action,expected_version:Number(row.version||0)})});
        if(session!==s.session)return;Object.assign(row,result);if(id===s.id&&s.detail&&Number(s.detail.version)<=Number(result.version))Object.assign(s.detail,result);
        if(id===s.id)chat.renderThread();void chat.loadList();
      }catch(error){C.showToast(chat.errorText(error));if(id===s.id)void chat.loadThread();}
      finally{if(session===s.session)s.controls.delete(id);}
    })();s.controls.set(id,task);return task;
  };
  chat.send=async function(retry){
    if(s.sending||!s.id)return;
    const id=s.id,session=s.session,text=chat.el('input').value.trim(),media=chat.media;
    if(!retry&&!text&&!media)return;
    if(chat.recording){C.showToast('Pare a gravação e ouça o áudio antes de enviar.');return;}
    s.sending=true;
    const token=retry?retry.client_token:crypto.randomUUID();
    let body;
    try{body=retry?retry.request:{client_token:token,content:text,
      file:media?{mime:media.mime,base64:await chat.toBase64(media.blob)}:undefined,photo_request_id:media?.photoRequestId};}
    catch(_){s.sending=false;C.showToast('Não consegui preparar o anexo. Tente novamente.');return;}
    if(session!==s.session)return;
    const pending=retry||{id:token,client_token:token,conversation_id:id,content:body.content,sent_at:new Date().toISOString(),
      local:true,request:body,status:'pending',preview:media?.url,mime:media?.mime};
    s.pending.set(token,pending);s.sending=true;pending.status='sending';
    if(!retry){if(s.id===id)chat.el('input').value='';s.drafts.delete(id);if(chat.media===media)chat.media=null;chat.renderMedia();}
    chat.renderThread();
    try{
      const result=await chat.api(chat.path(id)+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(session!==s.session)return;Object.assign(pending,{id:result.id,status:result.status,local:false});
      if(id===s.id){s.threadBusy=false;void chat.loadThread();}
    }catch(error){pending.status=error.status?'failed':'unknown';pending.error=chat.errorText(error);}
    finally{if(session===s.session){s.sending=false;chat.renderThread();}}
  };
  chat.retryFailed=async function(token){
    const pending=s.pending.get(token);if(!pending||s.sending)return;
    s.sending=true;const session=s.session;
    try{const result=await chat.api(chat.path(pending.conversation_id)+'/messages/'+pending.id+'/retry',{method:'POST'});
      if(session===s.session){Object.assign(pending,result);void chat.loadThread();}}
    catch(error){C.showToast(chat.errorText(error));}
    finally{if(session===s.session){s.sending=false;chat.renderThread();}}
  };
  chat.connect=async function(generation){
    if(!s.active||generation!==s.generation||!C.token())return;
    const controller=new AbortController();s.stream=controller;let watchdog;
    const heartbeat=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>controller.abort(),25000);};
    try{
      heartbeat();const response=await C.authenticatedFetch('/api/caixa/chat/stream',{signal:controller.signal});
      if(!response.ok||!response.body)throw Error('stream_unavailable');
      s.connected=true;chat.renderConnection();
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(s.active&&generation===s.generation){
        const chunk=await reader.read();if(chunk.done)break;heartbeat();buffer+=decoder.decode(chunk.value,{stream:true});
        const blocks=buffer.split('\n\n');buffer=blocks.pop();
        for(const block of blocks){const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
          try{const event=JSON.parse(line.slice(6));void chat.loadList();if(event.conversation_id===s.id)void chat.loadThread();}catch(_){/* heartbeat */}}
      }
    }catch(_){/* consulta periódica permanece ativa */}
    finally{clearTimeout(watchdog);controller.abort();if(generation===s.generation){s.connected=false;chat.renderConnection();
      if(s.active)s.retry=setTimeout(()=>void chat.connect(generation),1500);}}
  };
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&s.active){void chat.loadList();void chat.loadThread();void chat.channels?.refresh(true);}});
}());
