window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosLogistica=function(){
  let request=0,imageRequest=0;
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const day=d=>d.toISOString().slice(0,10),parse=d=>new Date(d+'T12:00:00Z');
  return {
    rlog:{tab:'overview',mode:'month',month:today().slice(0,7),from:'',to:'',courier:'',status:'all',search:'',trip:'',delivery:'all',receipt:'all',
      data:null,loading:false,error:'',exportError:'',exporting:false,page:1,selected:'',saved:false,notice:'',showRules:false,
      imageUrl:'',imageOpen:false,imageLoading:false,imageError:''},
    rlogOpen(){try{this.rlog.saved=!!localStorage.getItem(this.rlogStorageKey());}catch(_){}if(!this.rlog.from)this.rlogPeriod('month');else void this.rlogLoad();},
    rlogPeriod(mode,step=0){
      const old=this.rlog.mode;this.rlog.mode=mode;if(mode==='custom')return;
      let start,end;
      if(mode==='month'){start=parse((this.rlog.month||today().slice(0,7))+'-01');start.setUTCMonth(start.getUTCMonth()+step);
        if(day(start)>today())start=parse(today().slice(0,7)+'-01');end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1,0);this.rlog.month=day(start).slice(0,7);
      }else{start=parse(old==='week'&&this.rlog.from?this.rlog.from:today());start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7+step*7);
        if(day(start)>today()){start=parse(today());start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);}end=new Date(start);end.setUTCDate(end.getUTCDate()+6);}
      this.rlog.from=day(start);this.rlog.to=day(end)>today()?today():day(end);void this.rlogLoad();
    },
    rlogQuery(filters=null,view=this.rlog.tab){const f=filters||this.rlog;return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,
      courier:f.courier,status:f.status,search:f.search,trip:f.trip,delivery:f.delivery,receipt:f.receipt,view}).toString();},
    async rlogLoad(){
      const id=++request;Object.assign(this.rlog,{loading:true,error:'',exportError:'',page:1});
      const from=parse(this.rlog.from),to=parse(this.rlog.to);
      if(!Number.isFinite(+from)||!Number.isFinite(+to)||day(from)!==this.rlog.from||day(to)!==this.rlog.to||from>to||this.rlog.to>today()||to-from>365*86400000){
        this.rlog.data=null;this.rlog.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rlog.loading=false;return;
      }
      try{const data=await this.apiGet('/admin/api/relatorios/logistica?'+this.rlogQuery());if(id!==request)return;
        this.rlog.data=data;if(!data.trips.some(row=>row.id===this.rlog.selected))this.rlog.selected=data.trips[0]?.id||'';
      }catch(error){if(id===request){this.rlog.data=null;this.rlog.selected='';const message=String(error.message);
        this.rlog.error=message.includes('409')?'A Logística da Matriz está desativada.':message.includes('422')?'O período tem muitos registros. Selecione um intervalo menor.':'Não foi possível consultar as rotas. Tente novamente.';}}
      finally{if(id===request)this.rlog.loading=false;}
    },
    rlogTab(tab){this.rlog.tab=tab;this.rlog.page=1;},
    rlogReset(){Object.assign(this.rlog,{courier:'',status:'all',search:'',trip:'',delivery:'all',receipt:'all'});void this.rlogLoad();},
    rlogSeeDeliveries(row){Object.assign(this.rlog,{tab:'deliveries',trip:row.id,delivery:'all'});void this.rlogLoad();},
    rlogSeeCosts(row){Object.assign(this.rlog,{tab:'costs',trip:row.id,receipt:'all'});void this.rlogLoad();},
    rlogStorageKey(){return this.rpStorageKey()+':logistica';},
    rlogSaveView(){if(!this.rlog.data||this.rlog.loading||this.rlogUnapplied)return;
      try{localStorage.setItem(this.rlogStorageKey(),JSON.stringify({filters:this.rlog.data.filters,tab:this.rlog.tab}));this.rlog.saved=true;this.rlog.notice='Visão de Logística salva neste navegador.';}
      catch(_){this.rlog.notice='O navegador não permitiu salvar a visão.';}},
    rlogRestoreView(){try{const saved=JSON.parse(localStorage.getItem(this.rlogStorageKey())||'null');if(!saved?.filters)return;
      for(const key of ['from','to','mode','courier','status','search','trip','delivery','receipt']){if(typeof saved.filters[key]!=='string'||saved.filters[key].length>200)throw Error('invalid');this.rlog[key]=saved.filters[key];}
      this.rlog.month=this.rlog.from.slice(0,7);this.rlog.tab=['overview','trips','deliveries','costs'].includes(saved.tab)?saved.tab:'overview';
      this.rlog.notice='Visão restaurada. Os registros foram consultados novamente.';void this.rlogLoad();
    }catch(_){this.rlog.notice='Não foi possível restaurar a visão. Selecione os filtros novamente.';}},
    async rlogReceipt(id){
      this.rlogCloseReceipt();const current=++imageRequest;Object.assign(this.rlog,{imageOpen:true,imageLoading:true,imageError:''});
      this.$nextTick(()=>this.$refs.rlogReceiptDialog?.showModal());
      try{const response=await fetch('/admin/api/logistica/comprovantes/'+encodeURIComponent(id)+'/imagem',{credentials:'same-origin',headers:this.apiHeaders()});
        if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error('receipt');const blob=await response.blob();if(current!==imageRequest)return;
        this.rlog.imageUrl=URL.createObjectURL(blob);
      }catch(_){if(current===imageRequest)this.rlog.imageError='Não foi possível abrir este comprovante.';}finally{if(current===imageRequest)this.rlog.imageLoading=false;}
    },
    rlogCloseReceipt(){++imageRequest;if(this.rlog.imageUrl)URL.revokeObjectURL(this.rlog.imageUrl);this.rlog.imageUrl='';this.rlog.imageOpen=false;this.$refs?.rlogReceiptDialog?.close();},
  };
};
