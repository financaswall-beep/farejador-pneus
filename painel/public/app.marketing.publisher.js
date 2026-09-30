window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingPublisher = function () {
  return {
    mpMarkup: window.MARKETING_PUBLISHER_TEMPLATE,
    mpTab:'create', mpConfig:null, mpMedia:[], mpPosts:[], mpLoading:false, mpBusy:false, mpError:'', mpMessage:'',
    mpSearch:'', mpKind:'all', mpHistorySearch:'', mpHistoryNetwork:'all', mpUploadProgress:null,
    mpForm:null, mpDirty:false, mpBrief:'', mpAiBusy:false, mpCustom:false, mpWhen:'now', mpDate:'', mpTime:'09:00',
    mpConnectionsOpen:false, mpConnections:[], mpConnectionBusy:false, mpPreview:null, mpTimer:null, mpCalendarMonth:'',
    mpFresh() {
      this.mpForm={id:crypto.randomUUID(),version:0,title:'',media_id:null,caption:'',delete_after_publish:true,
        destinations:[{platform:'instagram',format:'feed',selected:true,caption:''},{platform:'facebook',format:'feed',selected:true,caption:''}]};
      this.mpDirty=false;this.mpBrief='';this.mpCustom=false;this.mpWhen='now';this.mpDate='';this.mpTab='create';
    },
    async mpLoad(quiet=false) {
      if(this.mpLoading)return;
      this.mpLoading=true;if(!quiet)this.mpError='';
      try {
        if(this.marketingIsMock?.()) {
          this.mpConfig={enabled:false,sending:false,schema_ready:true,storage_ready:false,ai_ready:false};this.mpMedia=[];this.mpPosts=[];
          this.mpError='A Central de publicações usa dados reais. Saia do modo demonstrativo para acessá-la.';return;
        }
        const data=await this.apiGet('/admin/api/marketing/publisher');
        this.mpConfig=data.config;this.mpMedia=data.media;this.mpPosts=data.posts;
        if(!this.mpForm)this.mpFresh();
        if(!this.mpCalendarMonth)this.mpCalendarMonth=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}).format(new Date());
        clearTimeout(this.mpTimer);
        if(this.mpPosts.some(p=>['scheduled','publishing'].includes(p.status)))this.mpTimer=setTimeout(()=>{
          if(this.currentPage==='marketing'&&this.moView==='publisher')void this.mpLoad(true);
        },15000);
      }catch(error){this.mpError=this.mpErrorText(error);}
      finally{this.mpLoading=false;this.$nextTick(()=>window.lucide?.createIcons());}
    },
    mpClose() {clearTimeout(this.mpTimer);this.mpTimer=null;this.mpPreview=null;},
    mpErrorText(error) {
      const messages={publisher_disabled:'A Central está desativada no servidor. Ative a configuração após aplicar a migration.',
        publisher_send_disabled:'O envio ainda não está habilitado. Confira as contas, as permissões e o Storage.',
        publisher_storage_missing:'Configure o Supabase Storage para enviar arquivos.',publisher_bucket_must_be_private:'O bucket de publicações precisa ser privado.',
        publisher_media_too_large:'Foto: até 8 MB. Vídeo: até o limite mostrado na biblioteca.',publisher_library_full:'A biblioteca atingiu o limite operacional. Libere arquivos antes de enviar outros.',
        publisher_version_conflict:'Este rascunho mudou em outra aba ou a resposta anterior se perdeu. Atualize e reabra o rascunho para conferir.',
        publisher_media_in_use:'Este arquivo está vinculado a um rascunho ou envio. Cancele a publicação antes de removê-lo.',
        publisher_upload_mismatch:'O arquivo enviado não corresponde ao arquivo reservado. Envie novamente.',
        publisher_media_invalid:'Não foi possível validar a mídia. Use JPG, PNG, WebP, MP4 ou MOV compatível.',
        publisher_format_incompatible:'Use Feed ou Story para foto; Reel ou Story para vídeo.',publisher_schedule_invalid:'Escolha um horário futuro, com pelo menos um minuto de antecedência.',
        publisher_story_too_long:'Stories de vídeo aceitam até 60 segundos nesta Central.',publisher_reel_too_long:'O vídeo excede a duração permitida para Reel.',
        publisher_facebook_reel_duration:'Para publicar Reel no Facebook, use um vídeo entre 4 e 60 segundos.',
        publisher_ai_rate_limit:'Limite de 10 gerações de texto por hora atingido.',publisher_ai_missing:'A geração de texto ainda não está configurada.',
        publisher_already_started:'O envio já começou. Aguarde a confirmação antes de tomar outra ação.',
        publisher_retry_not_allowed:'Só é possível repetir destinos com falha confirmada. Envios incertos precisam de conferência.',
        invalid_publisher_request:'Confira os campos e os limites antes de continuar.'};
      return messages[error?.message]||'Não foi possível concluir. As alterações foram mantidas; atualize para conferir o estado antes de tentar novamente.';
    },
    mpVisibleMedia() {const q=this.mpSearch.trim().toLocaleLowerCase('pt-BR');return this.mpMedia.filter(m=>(this.mpKind==='all'||m.kind===this.mpKind)&&(!q||m.name.toLocaleLowerCase('pt-BR').includes(q)));},
    mpSelectedMedia() {return this.mpMedia.find(m=>m.id===this.mpForm?.media_id)||null;},
    mpSelectMedia(media) {
      if(!this.mpForm)this.mpFresh();
      this.mpForm.media_id=media.id;this.mpDirty=true;
      if(!this.mpForm.title)this.mpForm.title=media.name.replace(/\.[^.]+$/,'');
      this.mpForm.destinations.forEach(d=>{if(media.kind==='photo'&&d.format==='reel')d.format='feed';if(media.kind==='video'&&d.format==='feed')d.format='reel';});
    },
    mpCount(status) {return this.mpPosts.filter(p=>p.status===status).length;},
    mpAttention() {return this.mpPosts.filter(p=>['partial','failed'].includes(p.status)).length;},
    mpUpcoming() {return this.mpPosts.filter(p=>p.status==='scheduled').sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).slice(0,3);},
    mpStatus(status) {return ({draft:'Rascunho',scheduled:'Agendada',publishing:'Enviando',published:'Publicada',partial:'Envio parcial',failed:'Precisa de atenção',cancelled:'Cancelada',queued:'Na fila',preparing:'Preparando',processing:'Processando',verifying:'Conferindo',uncertain:'Conferir na rede'})[status]||status;},
    mpFormat(format) {return ({feed:'Feed',reel:'Reel',story:'Story'})[format]||format;},
    mpDateLabel(date) {return date?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(date)):'Sem agendamento';},
    mpBytes(bytes) {return Number(bytes)>=1024*1024*1024?(Number(bytes)/1024/1024/1024).toFixed(1)+' GB':(Number(bytes)/1024/1024).toFixed(1)+' MB';},
    mpFilteredPosts() {
      const states=this.mpTab==='drafts'?['draft']:['published','partial','failed','publishing','cancelled'];
      const q=this.mpHistorySearch.toLocaleLowerCase('pt-BR');
      return this.mpPosts.filter(p=>states.includes(p.status)&&(!q||p.title.toLocaleLowerCase('pt-BR').includes(q))&&
        (this.mpHistoryNetwork==='all'||p.destinations.some(d=>d.platform===this.mpHistoryNetwork)));
    },
    mpPayload() {return {version:this.mpForm.version,title:this.mpForm.title,media_id:this.mpForm.media_id,caption:this.mpForm.caption,
      delete_after_publish:this.mpForm.delete_after_publish,destinations:this.mpForm.destinations.filter(d=>d.selected)
        .map(d=>({platform:d.platform,format:d.format,...(this.mpCustom?{caption:d.caption}:{})}))};},
    async mpPersist() {
      if(this.marketingIsMock?.())throw new Error('publisher_demo_disabled');
      const saved=await this.apiPut('/admin/api/marketing/publisher/posts/'+this.mpForm.id,this.mpPayload());
      this.mpForm.version=saved.version;this.mpDirty=false;return saved;
    },
    async mpSave() {
      if(this.mpBusy)return;this.mpBusy=true;this.mpError='';this.mpMessage='';
      try {await this.mpPersist();this.mpMessage='Rascunho salvo.';await this.mpLoad(true);}
      catch(error){this.mpError=this.mpErrorText(error);}finally{this.mpBusy=false;}
    },
    async mpSubmit() {
      if(this.mpBusy || !this.mpConfig?.sending || this.marketingIsMock?.())return;
      if(!this.mpSelectedMedia()){this.mpError='Escolha uma foto ou um vídeo.';return;}
      const selected=this.mpForm.destinations.filter(d=>d.selected);
      if(!selected.length){this.mpError='Escolha pelo menos uma rede social.';return;}
      const scheduled=this.mpWhen==='schedule'?new Date(this.mpDate+'T'+this.mpTime+':00-03:00'):null;
      if(scheduled && (!Number.isFinite(scheduled.getTime())||scheduled.getTime()<Date.now()+60000)){this.mpError='Escolha uma data e um horário futuros, em Brasília.';return;}
      if(!window.confirm((scheduled?'Agendar':'Publicar agora')+' em '+selected.map(d=>d.platform==='instagram'?'Instagram':'Facebook').join(' e ')+'? Confira o texto e a mídia antes de confirmar.'))return;
      this.mpBusy=true;this.mpError='';this.mpMessage='';
      try {
        await this.mpPersist();
        if(this.marketingIsMock?.())throw new Error('publisher_demo_disabled');
        await this.apiPost('/admin/api/marketing/publisher/posts/'+this.mpForm.id+'/submit',{version:this.mpForm.version,scheduled_at:scheduled?.toISOString()||null});
        this.mpFresh();this.mpTab=scheduled?'calendar':'published';this.mpMessage=scheduled?'Publicação agendada.':'Envio iniciado. Acompanhe a confirmação de cada rede.';
        await this.mpLoad(true);
      }catch(error){this.mpError=this.mpErrorText(error);await this.mpLoad(true);}finally{this.mpBusy=false;}
    },
    mpEdit(post) {
      if(this.mpDirty&&!window.confirm('Abrir outro rascunho e descartar as alterações não salvas?'))return;
      this.mpForm={...post,destinations:['instagram','facebook'].map(platform=>{
        const d=post.destinations.find(d=>d.platform===platform);return {...(d||{platform,format:'feed',caption:''}),selected:Boolean(d)};
      })};this.mpCustom=post.destinations.some(d=>Object.hasOwn(d,'caption'));this.mpTab='create';this.mpDirty=false;
    },
    mpNew() {if(this.mpDirty&&!window.confirm('Descartar as alterações não salvas?'))return;this.mpFresh();},
    async mpAction(post,action) {
      if(this.mpBusy || this.marketingIsMock?.() || !window.confirm(action==='cancel'?'Cancelar esta publicação?':'Tentar novamente somente as redes com falha confirmada?'))return;
      this.mpBusy=true;this.mpError='';
      try{await this.apiPost('/admin/api/marketing/publisher/posts/'+post.id+'/action',{action});await this.mpLoad(true);}
      catch(error){this.mpError=this.mpErrorText(error);}finally{this.mpBusy=false;}
    },
    async mpGenerateCaption() {
      if(this.mpAiBusy || !this.mpBrief.trim() || this.marketingIsMock?.())return;
      this.mpAiBusy=true;this.mpError='';
      try{const result=await this.apiPost('/admin/api/marketing/publisher/caption',{brief:this.mpBrief});
        if(this.mpForm.caption&&!window.confirm('Substituir a legenda atual pela sugestão da IA?'))return;
        this.mpForm.caption=result.caption;this.mpDirty=true;this.mpMessage='Texto sugerido. Revise os fatos antes de publicar.';}
      catch(error){this.mpError=this.mpErrorText(error);}finally{this.mpAiBusy=false;}
    },
    async mpCheckConnections() {
      if(this.marketingIsMock?.())return;
      this.mpConnectionsOpen=true;this.mpConnectionBusy=true;
      try{this.mpConnections=(await this.apiPost('/admin/api/marketing/publisher/connections',{})).connections;}
      catch(error){this.mpError=this.mpErrorText(error);}finally{this.mpConnectionBusy=false;}
    },
    mpConnectionLabel(platform) {const c=this.mpConnections.find(c=>c.platform===platform);return c?c.verified?'Conta verificada':'Revisar conexão':'Configuração do servidor';},
    mpCalendarMove(delta) {
      const [year,month]=this.mpCalendarMonth.split('-').map(Number);const d=new Date(Date.UTC(year,month-1+delta,1));
      this.mpCalendarMonth=d.toISOString().slice(0,7);
    },
    mpCalendarLabel() {return this.mpCalendarMonth?new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC',month:'long',year:'numeric'}).format(new Date(this.mpCalendarMonth+'-01T12:00:00Z')):'';},
    mpCalendarDays() {
      if(!this.mpCalendarMonth)return [];
      const [y,m]=this.mpCalendarMonth.split('-').map(Number);const start=new Date(Date.UTC(y,m-1,1));const count=new Date(Date.UTC(y,m,0)).getUTCDate();
      return Array.from({length:start.getUTCDay()+count},(_,i)=>{
        const day=i-start.getUTCDay()+1;if(day<1)return {key:'empty'+i,day:null,posts:[]};
        const date=this.mpCalendarMonth+'-'+String(day).padStart(2,'0');
        return {key:date,day,posts:this.mpPosts.filter(p=>p.scheduled_at&&['scheduled','publishing','published','partial','failed'].includes(p.status)&&
          new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(p.scheduled_at))===date)};
      });
    },
  };
};
