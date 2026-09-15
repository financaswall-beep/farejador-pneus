window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.vendasLotes = function () {
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const form=()=>({buyer_key:'',new_buyer:false,name:'',phone:'',description:'Pneus para borracharia',quantity:'',amount:'',discount:'',sold_on:today(),payment_status:'paid',payment_method:'Pix',due_date:'',notes:'',mode:'oldest',allocations:{}});
  const cents=value=>Math.round(Number(value||0)*100);
  const prorate=(value,qty,total)=>total>0?Number((BigInt(value)*BigInt(qty)*2n+BigInt(total))/(BigInt(total)*2n)):0;
  return {
    lotSales:{view:'new',form:form(),lots:[],buyers:[],rows:[],total:0,page:1,loading:false,request:0,error:'',message:'',saving:false,pending:null,finance:false,selected:null,cancelOpen:false,cancelReason:'',cancelPending:null},
    lsIcons(){this.$nextTick(()=>window.lucide?.createIcons());},
    lsAmount(value){const text=String(value??'').replace(/R\$|\s/g,'');const grouped=/^\d{1,3}(?:\.\d{3})+$/.test(text);const n=Number(text.includes(',')||grouped?text.replace(/\./g,'').replace(',','.'):text);return Number.isFinite(n)?n:0;},
    lsMoneyValid(value){const text=String(value??'').trim().replace(/^R\$\s*/, '');return !text || /^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(text) || /^\d+(?:\.\d{1,2})?$/.test(text);},
    lsKey(){return 'farejador:lot-sale:'+this.serverEnvironment+':'+(this.adminUser?.collaborator_id||this.adminUser?.id||this.adminUser?.username||this.adminUser?.display_name||'owner');},
    lsRemember(){try{sessionStorage.setItem(this.lsKey(),JSON.stringify({form:this.lotSales.form,pending:this.lotSales.pending}));return true;}catch(_){return false;}},
    lsDraft(){this.lotSales.message=this.lsRemember()?'Rascunho salvo nesta sessão do navegador. Nenhuma venda foi confirmada.':'Não foi possível guardar o rascunho neste navegador.';},
    async lsOpen(lot=null){
      this.currentPage='vendas';this.vendasTab='lotes';this.lotSales.view='new';this.lotSales.message='';
      if(!this.lotSales.pending&&!this.lotSales.form.quantity){try{const draft=JSON.parse(sessionStorage.getItem(this.lsKey())||'null');if(draft?.form){this.lotSales.form={...form(),...draft.form};this.lotSales.pending=draft.pending||null;}}catch(_){}}
      await this.loadLotSalesPage();
      if(lot&&!this.lotSales.pending){this.lotSales.form={...form(),mode:'manual',allocations:{[lot.id]:Number(lot.available_quantity)},quantity:Number(lot.available_quantity),description:lot.description};}
      this.lsIcons();
    },
    async loadLotSalesPage(){
      if(!this.isMatrixPanel()||this.vendasTab!=='lotes')return;
      const s=this.lotSales,request=++s.request;s.loading=true;s.error='';
      try{
        const [data,buyers]=await Promise.all([this.apiGet('/admin/api/wholesale/lot-sales?page='+s.page),this.apiGet('/admin/api/wholesale/buyers')]);
        if(request!==s.request)return;
        if(data.ready===false){s.lots=[];s.rows=[];s.total=0;s.selected=null;s.finance=false;s.error='A venda de lotes precisa da atualização 0232 do banco. Nenhuma venda será lançada antes dela.';return;}
        s.rows=data.rows;s.total=data.total;s.lots=data.lots;s.buyers=buyers.rows||[];s.finance=data.finance_enabled;
        if(s.selected)s.selected=s.rows.find(row=>row.id===s.selected.id)||null;
        this.lsIcons();
      }catch(_){if(request===s.request){s.lots=[];s.rows=[];s.total=0;s.selected=null;s.error='Não foi possível consultar os lotes e as vendas. Tente novamente.';}}
      finally{if(request===s.request)s.loading=false;}
    },
    get lsBuyer(){return this.lotSales.buyers.find(b=>this.atacadoBuyerKey(b)===this.lotSales.form.buyer_key)||null;},
    get lsPlan(){
      const s=this.lotSales,f=s.form;let remaining=Number(f.quantity)||0;
      if(!Number.isSafeInteger(remaining)||remaining<0||remaining>100000)return [];
      return s.lots.map(lot=>{
        const available=Number(lot.available_quantity),manual=Number(f.allocations[lot.id]||0);
        const requested=f.mode==='manual'?manual:Math.min(remaining,available);
        const quantity=Number.isSafeInteger(requested)&&requested>=0?requested:0;
        if(f.mode!=='manual')remaining-=quantity;
        const cost=quantity<=Number(lot.quantity_on_hand)?prorate(cents(lot.remaining_cost),quantity,Number(lot.quantity_on_hand)):0;
        return {...lot,quantity,cost_cents:cost,after:Number(lot.quantity_on_hand)-quantity,valid:quantity===requested&&quantity<=available};
      });
    },
    get lsUsed(){return this.lsPlan.filter(row=>row.quantity>0);},
    get lsCost(){return this.lsUsed.reduce((sum,row)=>sum+row.cost_cents,0)/100;},
    get lsNet(){return (cents(this.lsAmount(this.lotSales.form.amount))-cents(this.lsAmount(this.lotSales.form.discount)))/100;},
    get lsSelectedQuantity(){return this.lsUsed.reduce((sum,row)=>sum+row.quantity,0);},
    get lsRemaining(){return this.lsUsed.reduce((sum,row)=>sum+row.after,0);},
    get lsProblem(){
      const s=this.lotSales,f=s.form,qty=Number(f.quantity);
      if(!s.finance)return 'O financeiro integrado precisa estar ativo para confirmar a venda.';
      if(s.loading||s.error)return 'Aguarde a consulta dos saldos.';
      if(!f.new_buyer&&!this.lsBuyer)return 'Selecione o cliente.';
      if(f.new_buyer&&f.name.trim().length<2)return 'Informe o nome do cliente.';
      if(f.description.trim().length<2)return 'Informe a descrição da venda.';
      if(!Number.isInteger(qty)||qty<1||qty>100000)return 'Informe uma quantidade válida.';
      if(this.lsPlan.some(row=>!row.valid)||this.lsSelectedQuantity!==qty)return 'Distribua exatamente a quantidade vendida, respeitando o saldo disponível.';
      if(!this.lsMoneyValid(f.amount)||!this.lsMoneyValid(f.discount)||this.lsAmount(f.amount)<=0||this.lsAmount(f.amount)>99999999.99||this.lsAmount(f.discount)<0||this.lsNet<=0)return 'Confira o valor negociado e o desconto.';
      if(!f.sold_on||f.sold_on>today())return 'A data da venda não pode estar no futuro.';
      if(f.payment_status==='pending'&&(!f.due_date||f.due_date<f.sold_on))return 'Informe um vencimento igual ou posterior à venda.';
      return '';
    },
    lsManual(){const allocations={};for(const row of this.lsPlan)allocations[row.id]=row.quantity;this.lotSales.form.allocations=allocations;this.lotSales.form.mode='manual';},
    lsError(error){return ({lot_sale_stock_changed:'O saldo mudou. Atualize os lotes e confira a distribuição.',lot_sale_cost_changed:'O custo mudou. Atualize os lotes e revise o resumo antes de confirmar.',lot_sale_lot_unavailable:'Um lote selecionado não está mais disponível.',lot_sale_before_receipt:'A venda não pode ter data anterior ao recebimento dos lotes.',lot_sale_finance_required:'Ative o financeiro integrado antes de confirmar.',lot_sales_migration_required:'Falta aplicar a atualização 0232 do banco.',idempotency_conflict:'Esta confirmação já foi usada com outros dados.',sale_already_cancelled:'A venda já foi cancelada.',due_date_invalid:'Confira o vencimento.',buyer_not_found:'O cliente não está mais disponível. Selecione novamente.',sold_at_future:'A data da venda não pode estar no futuro.'})[error.message]||'Não foi possível confirmar o resultado. Tente novamente com os mesmos dados.';},
    async lsSubmit(){
      const s=this.lotSales,f=s.form;if(s.saving)return;if(!s.pending&&this.lsProblem){s.message=this.lsProblem;return;}
      if(!s.pending){
        const buyer=this.lsBuyer;
        s.pending={description:f.description,sold_on:f.sold_on,amount:this.lsAmount(f.amount),discount:this.lsAmount(f.discount),expected_cost:this.lsCost,
          payment_status:f.payment_status,...(f.payment_status==='paid'?{payment_method:f.payment_method}:{due_date:f.due_date}),notes:f.notes,
          allocations:this.lsUsed.map(row=>({lot_id:row.id,quantity:row.quantity})),idempotency_key:crypto.randomUUID(),
          ...(f.new_buyer?{new_customer:{name:f.name,phone:f.phone}}:buyer.customer_id?{customer_id:buyer.customer_id}:{partner_id:buyer.partner_id})};
      }
      this.lsRemember();s.saving=true;s.message='';
      try{const result=await this.apiPost('/admin/api/wholesale/lot-sales',s.pending);s.pending=null;s.form=form();try{sessionStorage.removeItem(this.lsKey());}catch(_){}s.view='history';s.page=1;await this.loadLotSalesPage();s.selected=s.rows.find(row=>row.id===result.order_id)||null;s.message='Venda confirmada. Estoque e financeiro atualizados.';}
      catch(error){s.message=this.lsError(error);if(error.status>=400&&error.status<500){s.pending=null;this.lsRemember();}}
      finally{s.saving=false;this.lsIcons();}
    },
    async lsHistory(page=1){this.lotSales.view='history';this.lotSales.page=page;await this.loadLotSalesPage();},
    lsCancelOpen(){this.lotSales.cancelOpen=true;this.lotSales.cancelReason='';this.$nextTick(()=>document.getElementById('ls-cancel-reason')?.focus());},
    async lsCancel(){
      const s=this.lotSales;if(s.saving||!s.selected||s.cancelReason.trim().length<5)return;
      s.saving=true;s.message='';if(!s.cancelPending)s.cancelPending={order_id:s.selected.id,reason:s.cancelReason.trim(),idempotency_key:crypto.randomUUID()};
      try{const {order_id,...body}=s.cancelPending;await this.apiPost('/admin/api/wholesale/lot-sales/'+order_id+'/cancel',body);s.cancelPending=null;s.cancelOpen=false;await this.loadLotSalesPage();s.message='Venda cancelada. Os pneus voltaram aos lotes; o ajuste financeiro foi registrado.';}
      catch(error){s.message=this.lsError(error);if(error.status>=400&&error.status<500)s.cancelPending=null;}
      finally{s.saving=false;this.lsIcons();}
    },
    lsDate(value){return value?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value)):'—';}
  };
};
