window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemanda=function(){
  let request=0;const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const parse=d=>new Date(d+'T12:00:00Z'),date=d=>d.toISOString().slice(0,10);
  return{
    rdem:{tab:'overview',mode:'month',month:today().slice(0,7),from:'',to:'',compare:true,city:'',citySearch:'',measure:'',search:'',
      metric:'conversations',grain:'day',sort:'conversations',data:null,loading:false,error:'',page:1,saved:false,notice:'',showRules:false,showChartTable:false,allEvolutionCities:false,exporting:false,exportError:''},
    rdemOpen(){try{this.rdem.saved=!!localStorage.getItem(this.rdemStorageKey());}catch(_){}if(!this.rdem.from)this.rdemPeriod('month');else void this.rdemLoad();},
    rdemPeriod(mode,step=0){const old=this.rdem.mode;this.rdem.mode=mode;if(mode==='custom')return;let from,to;
      if(mode==='month'){from=parse((this.rdem.month||today().slice(0,7))+'-01');from.setUTCMonth(from.getUTCMonth()+step);if(date(from)>today())from=parse(today().slice(0,7)+'-01');to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1,0);this.rdem.month=date(from).slice(0,7);}
      else{from=parse(old==='week'&&this.rdem.from?this.rdem.from:today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7+step*7);if(date(from)>today()){from=parse(today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7);}to=new Date(from);to.setUTCDate(to.getUTCDate()+6);}
      this.rdem.from=date(from);this.rdem.to=date(to)>today()?today():date(to);void this.rdemLoad();
    },
    rdemQuery(filters=null){const f=filters||this.rdem;return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,compare:String(f.compare),city:f.city,citySearch:f.citySearch,
      measure:f.measure,search:f.search,view:f.view||f.tab,metric:f.metric,grain:f.grain,sort:f.sort}).toString();},
    async rdemLoad(){const id=++request;Object.assign(this.rdem,{loading:true,error:'',exportError:'',page:1});const from=parse(this.rdem.from),to=parse(this.rdem.to);
      if(this.rdem.tab==='evolution'&&this.rdem.citySearch)this.rdem.allEvolutionCities=true;
      if(!Number.isFinite(+from)||!Number.isFinite(+to)||date(from)!==this.rdem.from||date(to)!==this.rdem.to||from>to||this.rdem.to>today()||to-from>365*86400000){
        this.rdem.data=null;this.rdem.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rdem.loading=false;return;}
      try{const data=await this.apiGet('/admin/api/relatorios/demanda?'+this.rdemQuery());if(id!==request)return;this.rdem.data=data;this.rdem.city=data.filters.city;}
      catch(error){if(id===request){this.rdem.data=null;this.rdem.error=String(error.message).includes('422')?'Há muitos registros neste intervalo. Reduza o período.':'Não foi possível consultar a demanda. Tente novamente.';}}
      finally{if(id===request)this.rdem.loading=false;}
    },
    rdemCity(key,keepMeasure=false){Object.assign(this.rdem,{city:key,measure:keepMeasure?this.rdem.data?.selected_measure?.measure||'':'',search:''});void this.rdemLoad();},
    rdemMeasure(value){this.rdem.measure=value;void this.rdemLoad();},
    rdemTab(tab){this.rdem.tab=tab;this.rdem.showChartTable=false;void this.rdemLoad();},
    rdemReset(){Object.assign(this.rdem,{city:'',citySearch:'',measure:'',search:'',sort:'conversations',metric:'conversations'});void this.rdemLoad();},
    rdemStorageKey(){return this.rpStorageKey()+':demanda';},
    rdemSaveView(){if(!this.rdem.data||this.rdem.loading||this.rdemUnapplied)return;try{localStorage.setItem(this.rdemStorageKey(),JSON.stringify(this.rdem.data.filters));this.rdem.saved=true;this.rdem.notice='Visão de demanda salva neste navegador.';}catch(_){this.rdem.notice='O navegador não permitiu salvar a visão.';}},
    rdemRestoreView(){try{const f=JSON.parse(localStorage.getItem(this.rdemStorageKey())||'null');if(!f)return;
      for(const key of ['from','to','mode','city','citySearch','measure','search','metric','grain','sort']){if(typeof f[key]!=='string'||f[key].length>150)throw Error('invalid');this.rdem[key]=f[key];}
      this.rdem.tab=['overview','cities','measures','evolution'].includes(f.view)?f.view:'overview';this.rdem.compare=f.compare==='true';this.rdem.month=this.rdem.from.slice(0,7);
      this.rdem.notice='Visão restaurada. Os dados foram consultados novamente.';void this.rdemLoad();}catch(_){this.rdem.notice='Não foi possível restaurar a visão. Selecione os filtros novamente.';}},
  };
};
