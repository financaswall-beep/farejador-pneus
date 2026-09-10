window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatorios = function () {
  let request = 0;
  const day = d => d.toISOString().slice(0, 10);
  const parse = d => new Date(d + 'T12:00:00Z');
  const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date());
  return {
    rp: {report:'vendas', tab:'overview', librarySearch:'', mode:'month', month:today().slice(0,7),
      from:'', to:'', compare:true, channel:'all', brand:'', condition:'', measure:'', exact:false,
      data:null, loading:false, error:'', offset:0, productPage:1, expanded:'', selectedSale:null,
      saved:false, notice:'', exporting:false, exportError:'', showRules:false},
    rpOpen() {
      if(!this.hasPanelModule(this.rp.report==='compras'?'compras':'vendas'))this.rp.report=this.hasPanelModule('vendas')?'vendas':'compras';
      if(this.rp.report==='compras')return this.rcompOpen();
      try {this.rp.saved=!!localStorage.getItem(this.rpStorageKey());} catch (_) {}
      if(!this.rp.from)this.rpPeriod('month'); else void this.rpLoad();
    },
    rpPeriod(mode, step=0) {
      const old=this.rp.mode;this.rp.mode=mode;
      if(mode==='custom')return;
      let start,end;
      if(mode==='month') {
        start=parse((this.rp.month||today().slice(0,7))+'-01');start.setUTCMonth(start.getUTCMonth()+step);
        if(day(start)>today())start=parse(today().slice(0,7)+'-01');
        end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1,0);this.rp.month=day(start).slice(0,7);
      } else {
        start=parse(old==='week'&&this.rp.from?this.rp.from:today());
        start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7+step*7);
        if(day(start)>today())return this.rpPeriod('week',-1);
        end=new Date(start);end.setUTCDate(end.getUTCDate()+6);
      }
      this.rp.from=day(start);this.rp.to=day(end)>today()?today():day(end);void this.rpLoad();
    },
    rpQuery(filters=null) {
      const f=filters||this.rp;
      return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,compare:String(f.compare),channel:f.channel,
        brand:f.brand,condition:f.condition,measure:f.measure,exact:String(f.exact),offset:String(f.offset||0)}).toString();
    },
    async rpLoad(offset=0) {
      const id=++request;
      Object.assign(this.rp,{loading:true,error:'',exportError:'',offset,productPage:1,selectedSale:null,expanded:''});
      const from=parse(this.rp.from),to=parse(this.rp.to);
      if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||day(from)!==this.rp.from||day(to)!==this.rp.to
        ||this.rp.from>this.rp.to||this.rp.to>today()||to-from>365*86400000) {
        this.rp.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rp.loading=false;return;
      }
      try {
        const data=await this.apiGet('/admin/api/relatorios/vendas?'+this.rpQuery());
        if(id!==request)return;this.rp.data=data;
      } catch(err) {
        if(id===request)this.rp.error=String(err.message).includes('422')
          ?'Este período tem muitos itens. Reduza o período ou selecione um canal.'
          :'Não foi possível carregar o relatório. Tente novamente.';
      } finally {if(id===request)this.rp.loading=false;}
    },
    rpResetFilters() {Object.assign(this.rp,{channel:'all',brand:'',condition:'',measure:'',exact:false});void this.rpLoad();},
    rpSearchMeasure() {this.rp.exact=false;void this.rpLoad();},
    rpSeeSales(measure,brand=null,condition=null) {
      Object.assign(this.rp,{measure,exact:true,tab:'sales'});
      if(brand!==null)this.rp.brand=brand;if(condition!==null)this.rp.condition=condition;
      void this.rpLoad();
    },
    rpChoose(id) {
      const item=this.rpLibrary.find(row=>row.id===id);if(!item)return;
      if(id==='vendas') {
        this.rp.report='vendas';this.rp.tab='overview';this.rpOpen();return;
      }
      if(id==='compras'){this.rp.report='compras';this.rcompOpen();return;}
      this.currentPage=item.page;
      if(id==='faltas')this.bfOpen();
      if(id==='demanda'){this.botTab='demanda';this.$nextTick(()=>this.renderBotMapa());}
    },
    rpStorageKey() {return 'farejador_report_view_v1:'+String(this.panelWorkplace?.id||'matrix')+':'+String(this.adminUser?.username||this.adminUser?.display_name||'');},
    rpSaveView() {
      if(!this.rp.data||this.rp.loading||this.rpUnapplied)return;
      try {
        localStorage.setItem(this.rpStorageKey(),JSON.stringify({filters:this.rp.data.filters,report:this.rp.report,tab:this.rp.tab}));
        this.rp.saved=true;this.rp.notice='Visão salva neste navegador para o seu usuário.';
      } catch(_){this.rp.notice='O navegador não permitiu salvar a visão.';}
    },
    rpRestoreView() {
      try {
        const saved=JSON.parse(localStorage.getItem(this.rpStorageKey())||'null');
        if(!saved?.filters)return;
        for(const key of ['from','to','mode','channel','brand','condition','measure']) {
          if(typeof saved.filters[key]!=='string'||saved.filters[key].length>200)throw Error('invalid');
          this.rp[key]=saved.filters[key];
        }
        this.rp.compare=String(saved.filters.compare)==='true';this.rp.exact=String(saved.filters.exact)==='true';
        this.rp.month=this.rp.from.slice(0,7);this.rp.report='vendas';
        this.rp.tab=['overview','products','sales'].includes(saved.tab)?saved.tab:'overview';
        this.rp.notice='Visão restaurada. Os números foram consultados novamente.';void this.rpLoad();
      }catch(_){this.rp.notice='A visão salva não está disponível. Escolha os filtros novamente.';}
    },
  };
};
