window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFaltas=function(){
  let request=0;const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const parse=day=>new Date(day+'T12:00:00Z'),date=d=>d.toISOString().slice(0,10);
  return{
    rfal:{tab:'overview',mode:'month',month:today().slice(0,7),from:'',to:'',store:'',measure:'',search:'',storeSearch:'',allStores:false,
      data:null,loading:false,error:'',page:1,selected:'',saved:false,notice:'',showRules:false,exporting:false,exportError:''},
    rfalOpen(){try{this.rfal.saved=!!localStorage.getItem(this.rfalStorageKey());}catch(_){}if(!this.rfal.from)this.rfalPeriod('month');else void this.rfalLoad();},
    rfalPeriod(mode,step=0){const old=this.rfal.mode;this.rfal.mode=mode;if(mode==='custom')return;let from,to;
      if(mode==='month'){from=parse((this.rfal.month||today().slice(0,7))+'-01');from.setUTCMonth(from.getUTCMonth()+step);if(date(from)>today())from=parse(today().slice(0,7)+'-01');
        to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1,0);this.rfal.month=date(from).slice(0,7);
      }else{from=parse(old==='week'&&this.rfal.from?this.rfal.from:today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7+step*7);
        if(date(from)>today()){from=parse(today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7);}to=new Date(from);to.setUTCDate(to.getUTCDate()+6);}
      this.rfal.from=date(from);this.rfal.to=date(to)>today()?today():date(to);this.rfal.store='';this.rfal.measure='';void this.rfalLoad();
    },
    rfalQuery(filters=null,view=this.rfal.tab){const f=filters||this.rfal;return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,store:f.store,measure:f.measure,search:f.search,view}).toString();},
    async rfalLoad(){const id=++request;Object.assign(this.rfal,{loading:true,error:'',exportError:'',page:1});const from=parse(this.rfal.from),to=parse(this.rfal.to);
      if(!Number.isFinite(+from)||!Number.isFinite(+to)||date(from)!==this.rfal.from||date(to)!==this.rfal.to||from>to||this.rfal.to>today()||to-from>365*86400000){
        this.rfal.data=null;this.rfal.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rfal.loading=false;return;}
      try{const data=await this.apiGet('/admin/api/relatorios/faltas?'+this.rfalQuery());if(id!==request)return;this.rfal.data=data;this.rfal.store=data.filters.store;
        if(!data.consultations.some(c=>c.id===this.rfal.selected))this.rfal.selected=data.consultations[0]?.id||'';
      }catch(error){if(id===request){this.rfal.data=null;this.rfal.error=String(error.message).includes('422')?'Há muitos registros neste intervalo. Reduza o período.':'Não foi possível consultar as faltas. Tente novamente.';}}
      finally{if(id===request)this.rfal.loading=false;}
    },
    rfalStore(id){Object.assign(this.rfal,{store:id,measure:'',search:'',selected:'',allStores:false,storeSearch:''});void this.rfalLoad();},
    rfalMeasure(value){Object.assign(this.rfal,{measure:value,selected:'',page:1});void this.rfalLoad();},
    rfalSearch(){this.rfal.measure='';void this.rfalLoad();},
    rfalTab(tab){this.rfal.tab=tab;void this.rfalLoad();},
    rfalSeeConsultations(){this.rfal.measure=this.rfal.data?.selected_measure?.measure||'';this.rfalTab('consultations');},
    rfalSeePotential(){this.rfal.measure=this.rfalDetailMeasure?.measure||'';this.rfalTab('potential');},
    rfalStorageKey(){return this.rpStorageKey()+':faltas';},
    rfalSaveView(){if(!this.rfal.data||this.rfal.loading||this.rfalUnapplied)return;try{localStorage.setItem(this.rfalStorageKey(),JSON.stringify({filters:this.rfal.data.filters,tab:this.rfal.tab}));this.rfal.saved=true;this.rfal.notice='Visão de faltas salva neste navegador.';}catch(_){this.rfal.notice='O navegador não permitiu salvar a visão.';}},
    rfalRestoreView(){try{const saved=JSON.parse(localStorage.getItem(this.rfalStorageKey())||'null');if(!saved?.filters)return;
      for(const key of ['from','to','mode','store','measure','search']){if(typeof saved.filters[key]!=='string'||saved.filters[key].length>100)throw Error('invalid');this.rfal[key]=saved.filters[key];}
      this.rfal.month=this.rfal.from.slice(0,7);this.rfal.tab=['overview','measures','consultations','potential'].includes(saved.tab)?saved.tab:'overview';
      this.rfal.notice='Visão restaurada. Preços, estoque e faltas consultados novamente.';void this.rfalLoad();}catch(_){this.rfal.notice='Não foi possível restaurar a visão. Selecione os filtros novamente.';}},
  };
};
