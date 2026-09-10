window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosCompras = function () {
  let request = 0;
  const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date());
  const day = d => d.toISOString().slice(0,10), parse = d => new Date(d+'T12:00:00Z');
  return {
    rcomp:{tab:'overview',mode:'month',month:today().slice(0,7),from:'',to:'',compare:true,supplier:'',brand:'',condition:'',
      receipt:'all',measure:'',exact:false,offset:0,productPage:1,supplierPage:1,supplierSearch:'',chart:'value',
      data:null,loading:false,error:'',expanded:'',selectedSupplier:null,selectedPurchase:null,
      saved:false,notice:'',exporting:false,exportError:'',showRules:false},
    rcompOpen() {
      try {this.rcomp.saved=!!localStorage.getItem(this.rcompStorageKey());}catch(_){}
      if(!this.rcomp.from)this.rcompPeriod('month');else void this.rcompLoad();
    },
    rcompPeriod(mode,step=0) {
      const old=this.rcomp.mode;this.rcomp.mode=mode;if(mode==='custom')return;
      let start,end;
      if(mode==='month'){
        start=parse((this.rcomp.month||today().slice(0,7))+'-01');start.setUTCMonth(start.getUTCMonth()+step);
        if(day(start)>today())start=parse(today().slice(0,7)+'-01');
        end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1,0);this.rcomp.month=day(start).slice(0,7);
      }else{
        start=parse(old==='week'&&this.rcomp.from?this.rcomp.from:today());
        start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7+step*7);
        if(day(start)>today())return this.rcompPeriod('week',-1);
        end=new Date(start);end.setUTCDate(end.getUTCDate()+6);
      }
      this.rcomp.from=day(start);this.rcomp.to=day(end)>today()?today():day(end);void this.rcompLoad();
    },
    rcompQuery(filters=null,view=this.rcomp.tab) {
      const f=filters||this.rcomp;
      return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,compare:String(f.compare),supplier:f.supplier,
        brand:f.brand,condition:f.condition,receipt:f.receipt,measure:f.measure,exact:String(f.exact),offset:String(f.offset||0),view}).toString();
    },
    async rcompLoad(offset=0) {
      const id=++request;
      Object.assign(this.rcomp,{loading:true,error:'',exportError:'',offset,productPage:1,supplierPage:1,expanded:'',selectedSupplier:null,selectedPurchase:null});
      const from=parse(this.rcomp.from),to=parse(this.rcomp.to);
      if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||day(from)!==this.rcomp.from||day(to)!==this.rcomp.to
        ||this.rcomp.from>this.rcomp.to||this.rcomp.to>today()||to-from>365*86400000){
        this.rcomp.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rcomp.loading=false;return;
      }
      try{
        const data=await this.apiGet('/admin/api/relatorios/compras?'+this.rcompQuery());
        if(id===request)this.rcomp.data=data;
      }catch(err){if(id===request){this.rcomp.data=null;this.rcomp.error=String(err.message).includes('422')
        ?'Há muitos itens neste período. Reduza o período para continuar.'
        :'Não foi possível carregar o relatório de compras. Tente novamente.';
      }
      }finally{if(id===request)this.rcomp.loading=false;}
    },
    rcompResetFilters() {Object.assign(this.rcomp,{supplier:'',brand:'',condition:'',receipt:'all',measure:'',exact:false,supplierSearch:''});void this.rcompLoad();},
    rcompSearchMeasure() {this.rcomp.exact=false;void this.rcompLoad();},
    rcompSeePurchases(row) {Object.assign(this.rcomp,{measure:row.measure,brand:row.brand,condition:row.condition,exact:true,tab:'purchases'});void this.rcompLoad();},
    rcompSupplierReport(id,tab) {Object.assign(this.rcomp,{supplier:id,tab});void this.rcompLoad();},
    rcompStorageKey() {return this.rpStorageKey()+':compras';},
    rcompSaveView() {
      if(!this.rcomp.data||this.rcomp.loading||this.rcompUnapplied)return;
      try{localStorage.setItem(this.rcompStorageKey(),JSON.stringify({filters:this.rcomp.data.filters,tab:this.rcomp.tab}));
        this.rcomp.saved=true;this.rcomp.notice='Visão de compras salva neste navegador para o seu usuário.';
      }catch(_){this.rcomp.notice='O navegador não permitiu salvar a visão.';}
    },
    rcompRestoreView() {
      try{
        const saved=JSON.parse(localStorage.getItem(this.rcompStorageKey())||'null');if(!saved?.filters)return;
        for(const key of ['from','to','mode','supplier','brand','condition','receipt','measure']){
          if(typeof saved.filters[key]!=='string'||saved.filters[key].length>200)throw Error('invalid');this.rcomp[key]=saved.filters[key];
        }
        this.rcomp.compare=String(saved.filters.compare)==='true';this.rcomp.exact=String(saved.filters.exact)==='true';
        this.rcomp.month=this.rcomp.from.slice(0,7);this.rcomp.tab=['overview','products','suppliers','purchases'].includes(saved.tab)?saved.tab:'overview';
        this.rcomp.notice='Visão restaurada. Os números foram consultados novamente.';void this.rcompLoad();
      }catch(_){this.rcomp.notice='A visão salva não está disponível. Escolha os filtros novamente.';}
    },
  };
};
