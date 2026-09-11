window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosParceiros=function(){
  let request=0;const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const parse=day=>new Date(day+'T12:00:00Z'),date=d=>d.toISOString().slice(0,10);
  return{
    rpar:{tab:'overview',mode:'month',month:today().slice(0,7),from:'',to:'',compare:true,city:'',search:'',activity:'all',status:'all',sort:'sales',partner:'',channel:'all',commission_scope:'generated',
      data:null,loading:false,error:'',page:1,selected:'',selectedSale:'',selectedCommission:'',saved:false,notice:'',showRules:false,exporting:false,exportError:''},
    rparOpen(){try{this.rpar.saved=!!localStorage.getItem(this.rparStorageKey());}catch(_){}if(!this.rpar.from)this.rparPeriod('month');else void this.rparLoad();},
    rparPeriod(mode,step=0){const old=this.rpar.mode;this.rpar.mode=mode;if(mode==='custom')return;let from,to;
      if(mode==='month'){from=parse((this.rpar.month||today().slice(0,7))+'-01');from.setUTCMonth(from.getUTCMonth()+step);if(date(from)>today())from=parse(today().slice(0,7)+'-01');
        to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1,0);this.rpar.month=date(from).slice(0,7);
      }else{from=parse(old==='week'&&this.rpar.from?this.rpar.from:today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7+step*7);
        if(date(from)>today()){from=parse(today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7);}to=new Date(from);to.setUTCDate(to.getUTCDate()+6);}
      this.rpar.from=date(from);this.rpar.to=date(to)>today()?today():date(to);void this.rparLoad();
    },
    rparQuery(filters=null,view=this.rpar.tab){const f=filters||this.rpar;return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,compare:String(f.compare),city:f.city,search:f.search,
      activity:f.activity,status:f.status,sort:f.sort,partner:f.partner,channel:f.channel,commission_scope:f.commission_scope,view}).toString();},
    async rparLoad(){const id=++request;Object.assign(this.rpar,{loading:true,error:'',exportError:'',page:1});const from=parse(this.rpar.from),to=parse(this.rpar.to);
      if(!Number.isFinite(+from)||!Number.isFinite(+to)||date(from)!==this.rpar.from||date(to)!==this.rpar.to||from>to||this.rpar.to>today()||to-from>365*86400000){
        this.rpar.data=null;this.rpar.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rpar.loading=false;return;}
      try{const data=await this.apiGet('/admin/api/relatorios/parceiros?'+this.rparQuery());if(id!==request)return;this.rpar.data=data;this.rparEnsureSelection();}
      catch(error){if(id===request){this.rpar.data=null;this.rpar.error=String(error.message).includes('422')?'Este intervalo tem muitos registros. Reduza o período.':'Não foi possível consultar o desempenho dos parceiros. Tente novamente.';}}
      finally{if(id===request)this.rpar.loading=false;}
    },
    rparFilter(){this.rpar.partner='';void this.rparLoad();},
    rparReset(){Object.assign(this.rpar,{city:'',search:'',activity:'all',status:'all',sort:'sales',partner:'',channel:'all',commission_scope:'generated'});void this.rparLoad();},
    rparTab(tab){this.rpar.tab=tab;this.rpar.page=1;this.rparEnsureSelection();},
    rparEnsureSelection(){for(const [key,rows] of [['selected',this.rpar.data?.partners||[]],['selectedSale',this.rpar.data?.sales||[]],['selectedCommission',this.rpar.data?.commissions||[]]])
      if(!rows.some(row=>row.id===this.rpar[key]))this.rpar[key]=rows[0]?.id||'';},
    rparSeeSales(id){Object.assign(this.rpar,{partner:id,channel:'all',tab:'sales'});void this.rparLoad();},
    rparSeeCommissions(id){Object.assign(this.rpar,{partner:id,commission_scope:'generated',tab:'commissions'});void this.rparLoad();},
    async rparOpenRede(){const partnerId=this.rpar.selected;await this.loadRedeData();const index=this.parceirosRede.findIndex(p=>p.partnerId===partnerId);
      if(index<0){this.rpar.notice='Este parceiro não está disponível na consulta atual da Rede.';return;}this.currentPage='rede';this.selectParceiro(index);},
    rparStorageKey(){return this.rpStorageKey()+':parceiros';},
    rparSaveView(){if(!this.rpar.data||this.rpar.loading||this.rparUnapplied)return;try{localStorage.setItem(this.rparStorageKey(),JSON.stringify({filters:this.rpar.data.filters,tab:this.rpar.tab}));this.rpar.saved=true;this.rpar.notice='Visão de parceiros salva neste navegador.';}catch(_){this.rpar.notice='O navegador não permitiu salvar a visão.';}},
    rparRestoreView(){try{const saved=JSON.parse(localStorage.getItem(this.rparStorageKey())||'null');if(!saved?.filters)return;
      for(const key of ['from','to','mode','city','search','activity','status','sort','partner','channel','commission_scope']){if(typeof saved.filters[key]!=='string'||saved.filters[key].length>150)throw Error('invalid');this.rpar[key]=saved.filters[key];}
      this.rpar.compare=saved.filters.compare===true||saved.filters.compare==='true';this.rpar.month=this.rpar.from.slice(0,7);this.rpar.tab=['overview','partners','sales','commissions'].includes(saved.tab)?saved.tab:'overview';
      this.rpar.notice='Visão restaurada. Dados consultados novamente.';void this.rparLoad();}catch(_){this.rpar.notice='Não foi possível restaurar a visão. Selecione os filtros novamente.';}},
  };
};
