window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.fornecedorFinanceiro = function () {
  const root='/admin/api/matriz/financeiro/fornecedores';
  return {
    compraCreditoDisponivel(form) {
      const supplier = this.fornecedores?.find(row => row.id === form?.supplierKey);
      return Number(supplier?.supplier_credit_available || 0);
    },
    compraCreditoRecibo(result) {
      return Number(result.credit_applied) ? ' Crédito usado: '+this.sfMoney(result.credit_applied)+
        ' · saída de caixa: '+this.sfMoney(result.cash_paid)+' · saldo a pagar: '+this.sfMoney(result.remaining_balance)+'.' : '';
    },
    compraDiferenca(form,total) {
      return (Math.round(total*100) - Math.round(Number(form?.creditAmount || 0)*100))/100;
    },
    compraCreditoValido(form,total) {
      const amount = Number(form.creditAmount || 0);
      return Number.isFinite(amount) && amount >= 0 && amount <= Math.min(this.compraCreditoDisponivel(form),total)
        && Math.abs(amount*100-Math.round(amount*100)) < 1e-7;
    },
    sfRows:[],sfReady:false,sfWritable:false,sfLoading:false,sfError:'',sfNotice:'',sfProfile:null,sfTab:'Financeiro',
    sfForm:null,sfSaving:false,sfDetail:null,sfLoadSeq:0,sfSummarySeq:0,sfFile:null,sfReceiptTarget:null,
    sfCanRead(){return this.isMatrixPanel() && (this.adminUser?.role==='owner'||this.hasPanelModule('financeiro'));},
    sfMoney(n){return this.formatCurrency(Number(n));},
    sfTotal(key){const rows=this.sfProfile?this.sfRows.filter(r=>r.id===this.sfProfile):this.sfRows;
      return this.sfReady?this.sfMoney(rows.reduce((sum,r)=>sum+Math.round(Number(r[key])*100),0)/100):'—';},
    sfBalance(id,key){const row=this.sfRows.find(r=>r.id===id);return this.sfReady&&row?this.sfMoney(row[key]):'—';},
    async sfLoadSummary(){
      const seq=++this.sfSummarySeq;
      if(!this.sfCanRead()){this.sfReady=false;this.sfRows=[];return;}
      try{const data=await this.apiGet(root);
        if(seq===this.sfSummarySeq){this.sfRows=data.rows;this.sfReady=true;this.sfWritable=data.writable;}}
      catch{if(seq===this.sfSummarySeq){this.sfReady=false;this.sfWritable=false;this.sfError='Não foi possível atualizar os saldos financeiros.';}}
    },
    async sfOpen(id){
      if(this.sfSaving)return;
      this.sfProfile=id;this.sfTab=this.sfCanRead()?'Financeiro':'Resumo';this.sfForm=null;this.sfFile=null;this.sfReceiptTarget=null;this.sfDetail=null;this.sfNotice='';this.sfError='';
      await this.sfRefresh();
    },
    async sfRefresh(){
      const seq=++this.sfLoadSeq,id=this.sfProfile;
      if(!id||!this.sfCanRead())return;
      this.sfLoading=true;this.sfError='';
      try{const detail=await this.apiGet(root+'/'+id);
        if(seq===this.sfLoadSeq)this.sfDetail=detail;}
      catch{if(seq===this.sfLoadSeq){this.sfDetail=null;this.sfError='Não foi possível atualizar a ficha.';}}
      finally{if(seq===this.sfLoadSeq)this.sfLoading=false;this.$nextTick(()=>window.lucide?.createIcons());}
    },
    sfBack(){if(this.sfSaving)return;this.sfLoadSeq++;this.sfProfile=null;this.sfDetail=null;this.sfForm=null;this.sfError='';this.sfNotice='';this.sfLoading=false;this.sfFile=null;this.sfReceiptTarget=null;},
    sfCommercial(){return this.comprasSuppliers.find(r=>r.supplier_id===this.sfProfile) || this.sfDetail?.supplier || {};},
    sfBegin(action,row){
      this.sfNotice='';this.sfError='';this.sfFile=null;this.sfReceiptTarget=null;
      this.sfForm={action,source:row?.advance_id||this.sfDetail?.credits.find(c=>Number(c.available)>0)?.id||'',
        application_id:row?.id||'',amount:row?String(row.amount).replace('.',','):'',date:this.finHoje(),reason:'',method:'pix',account:'',reference:'',
        purchase:'',matches:[],distinct:[]};
      this.$nextTick(()=>this.$refs.sfAmount?.focus());
    },
    sfPurchaseKey(p){return p.purchase_id+':'+(p.installment_number||0);},
    sfSelectedPayable(){return this.sfDetail?.payables.find(p=>this.sfPurchaseKey(p)===this.sfForm?.purchase);},
    sfAvailable(){return Number(this.sfDetail?.credits.find(c=>c.id===this.sfForm?.source)?.available||0);},
    sfNumber(){return this.finParseValor(this.sfForm?.amount||'');},
    async sfUpload(id,file){
      if(!file)return;
      if(file.size>2097152)throw Error('Use uma imagem de até 2 MB.');
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível ler a foto.'));reader.readAsDataURL(file);});
      await this.apiPost(root+'/adiantamentos/'+id+'/comprovantes',{image});
    },
    async sfReceipt(id,file){
      if(this.sfSaving||!file)return;
      this.sfSaving=true;this.sfError='';
      try{await this.sfUpload(id,file);await this.sfRefresh();this.sfReceiptTarget=null;this.sfNotice='Comprovante anexado.';}
      catch(error){this.sfError=error.message;this.sfReceiptTarget=id;}finally{this.sfSaving=false;}
    },
    sfReceiptUrl(id,digest){return root+'/adiantamentos/'+id+'/comprovantes/'+digest;},
    async sfUseExisting(row){
      const file=this.sfFile;this.sfForm=null;this.sfFile=null;this.sfError='';
      this.sfNotice='Registro localizado · '+row.id.slice(0,8);
      if(file)await this.sfReceipt(row.id,file);
    },
    async sfSave(){
      if(this.sfSaving||!this.sfForm||this.adminUser?.role!=='owner')return;
      const f=this.sfForm,action=f.action,amount=this.sfNumber(),part=this.sfSelectedPayable();
      if(!Number.isFinite(amount)||amount<=0||!f.date||f.date>this.finHoje()||f.reason.trim().length<3){this.sfError='Confira o valor, a data e o motivo.';return;}
      if(action==='apply'&&!part){this.sfError='Escolha a compra e a parcela.';return;}
      const body={action,amount,supplier_id:this.sfProfile,occurred_at:this.businessFactInstant(f.date),reason:f.reason.trim()};
      if(action==='issue'||action==='refund')Object.assign(body,{cash_account:f.account.trim(),payment_method:f.method});
      if(action==='issue'&&f.reference.trim())body.bank_reference=f.reference.trim();
      if(action==='issue'&&f.distinct.length)body.distinct_from=f.distinct;
      if(['apply','refund','void'].includes(action))body.advance_id=f.source;
      if(action==='apply')Object.assign(body,{purchase_id:part.purchase_id,installment:part.installment_number||undefined});
      if(action==='restore')body.application_id=f.application_id;
      this.sfSaving=true;this.sfError='';this.sfNotice='';
      try{
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({...body,occurred_at:f.date})));
        const slot=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
        const op=window.PAINEL_INTEGRITY.operation('supplier-advance',slot);
        if(!op.occurred_at){op.occurred_at=body.occurred_at;window.PAINEL_INTEGRITY.save();}
        body.occurred_at=op.occurred_at;
        const result=await this.apiPost(root+'/movimentos',{...body,idempotency_key:op.key});
        window.PAINEL_INTEGRITY.complete('supplier-advance',slot);
        const file=this.sfFile;this.sfFile=null;this.sfForm=null;
        this.sfNotice='Movimento registrado.';
        await Promise.allSettled([this.sfLoadSummary(),this.sfRefresh(),this.loadComprasSuppliers(),this.loadComprasOverview(),this.loadComprasHistory(),this.loadFinanceiro?.(),this.loadFinExtrato?.()]);
        if(file&&action==='issue'){try{await this.sfUpload(result.id,file);await this.sfRefresh();}
          catch{this.sfReceiptTarget=result.id;this.sfError='Adiantamento registrado. Falta anexar o comprovante.';}}
      }catch(error){this.sfError=error.message;f.matches=error.payload?.matches||[];}
      finally{this.sfSaving=false;this.$nextTick(()=>window.lucide?.createIcons());}
    },
  };
};
