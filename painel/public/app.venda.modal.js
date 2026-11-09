// Obra 300 (2026-07-05): fatia do painel da MATRIZ — modal de venda manual/walk-in + período e meta da Rede.
// VERBATIM das linhas 550-604 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.vendaModal = function () {
  let customerRequest = 0;
  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const emptyAddress = () => ({ street:'',number:'',no_number:false,complement:'',district:'',city:'',uf:'',cep:'' });
  return {
    saleCustomer: { mode:'existing',query:'',rows:[],selected:null,loading:false,error:'',detail:null },
    saleAddress: { structured:false,fields:emptyAddress(),error:'' },
    saleCleanText(value) { return clean(value); },
    salePhoneFormat(value) {
      const raw=String(value || '');
      if (raw.startsWith('+') && !raw.startsWith('+55')) return '+'+raw.slice(1).replace(/\D/g,'');
      let digits=raw.replace(/\D/g,'');
      if (digits.startsWith('55') && digits.length>11) digits=digits.slice(2);
      if (digits.length>11) return raw;
      if (digits.length<=2) return digits;
      const local=digits.slice(2), split=local.length>8?5:4;
      return '('+digits.slice(0,2)+') '+local.slice(0,split)+(local.length>split?'-'+local.slice(split):'');
    },
    saleMaskInput(event,kind) {
      const input=event.target,raw=input.value,caret=input.selectionStart??raw.length;
      let digits=raw.slice(0,caret).replace(/\D/g,'').length;
      if(kind==='phone'&&raw.replace(/\D/g,'').startsWith('55')&&raw.replace(/\D/g,'').length>11)digits=Math.max(0,digits-2);
      const formatted=kind==='phone'?this.salePhoneFormat(raw):this.saleCepFormat(raw);
      if(kind==='phone')this.saleForm.customer_phone=formatted;else this.saleAddress.fields.cep=formatted;
      input.value=formatted;
      let next=0,count=0;
      while(next<formatted.length&&count<digits){if(/\d/.test(formatted[next]))count++;next++;}
      if(caret===raw.length)next=formatted.length;
      input.setSelectionRange(next,next);
    },
    salePhoneValid(value) {
      if(!value)return true;
      const raw=String(value).trim(),digits=raw.replace(/\D/g,'');
      if(raw.startsWith('+')&&!raw.startsWith('+55'))return /^\+[1-9]\d{7,14}$/.test(raw);
      const national=digits.startsWith('55')&&digits.length>11?digits.slice(2):digits;
      return /^[1-9]\d(?:9\d{8}|[2-5]\d{7})$/.test(national);
    },
    saleCepFormat(value) { const d=String(value||'').replace(/\D/g,'').slice(0,8);return d.slice(0,5)+(d.length>5?'-'+d.slice(5):''); },
    saleCustomerReset(mode='existing') {
      customerRequest++;
      this.saleCustomer={mode,query:'',rows:[],selected:null,loading:false,error:'',detail:null};
      this.saleForm.customer_name='';this.saleForm.customer_phone='';
    },
    async saleCustomerSearch() {
      const q=clean(this.saleCustomer.query),version=++customerRequest;
      this.saleCustomer.error='';this.saleCustomer.rows=[];
      if(q.length<2){this.saleCustomer.loading=false;return;}
      this.saleCustomer.loading=true;
      try {
        const data=await this.apiGet('/admin/api/orders/customer-search?q='+encodeURIComponent(q));
        if(version===customerRequest) this.saleCustomer.rows=data.rows||[];
      } catch {if(version===customerRequest)this.saleCustomer.error='Não foi possível buscar clientes. Tente novamente.';}
      finally {if(version===customerRequest)this.saleCustomer.loading=false;}
    },
    async saleCustomerSelect(row) {
      const version=++customerRequest;
      this.saleCustomer={mode:'existing',query:'',rows:[],selected:{...row},loading:false,error:'',detail:null};
      this.saleForm.customer_name=row.name||'';this.saleForm.customer_phone=this.salePhoneFormat(row.phone);
      try {
        const data=await this.apiGet('/admin/api/clientes/'+row.source+'/'+(row.id||row.source_id)+'/ficha');
        if(version===customerRequest)this.saleCustomer.detail=data;
      } catch { /* O resumo é opcional; a seleção continua identificada pelo UUID. */ }
    },
    async saleFromCustomer() {
      const c=this.clienteFichaCliente();
      if(!c || !['balcao','chatwoot'].includes(c.source))return;
      this.fecharFichaCliente();
      await this.openWalkinModal();
      if(this.saleModalOpen)await this.saleCustomerSelect({...c,id:c.source_id});
    },
    saleUseLastAddress() {
      const address=this.saleCustomer.detail?.customer?.address;
      if(address){this.saleAddress.structured=false;this.saleForm.delivery_address=address;}
    },
    salePrepareCustomer() {
      this.saleCustomer.error='';this.saleAddress.error='';
      if(!this.modalConv){
        if(this.saleCustomer.mode==='existing'&&!this.saleCustomer.selected){this.saleCustomer.error='Busque e selecione um cliente.';return false;}
        if(this.saleCustomer.mode==='new'){
          this.saleForm.customer_name=clean(this.saleForm.customer_name);
          if(!this.salePhoneValid(this.saleForm.customer_phone)){this.saleCustomer.error='Informe um telefone completo com DDD.';return false;}
          if(!this.saleForm.customer_name){this.saleCustomer.error='Informe o nome do novo cliente.';return false;}
        }
      }
      if(this.saleAddress.structured && this.saleForm.fulfillment_mode==='delivery'){
        const a=this.saleAddress.fields;
        if(!clean(a.street)||(!a.no_number&&!clean(a.number))||!clean(a.district)||!clean(a.city)||!/^[A-Z]{2}$/.test(a.uf)){
          this.saleAddress.error='Preencha rua, número (ou sem número), bairro, cidade e UF.';return false;
        }
        if(a.cep&&a.cep.replace(/\D/g,'').length!==8){this.saleAddress.error='O CEP precisa ter 8 dígitos.';return false;}
        this.saleForm.delivery_address=[clean(a.street),a.no_number?'s/n':clean(a.number),clean(a.complement),clean(a.district),clean(a.city)+' - '+a.uf,a.cep].filter(Boolean).join(', ');
      }
      return true;
    },
    openSaleModal(conv) {
      this.modalConv = conv; this.saleVehicleType = 'all';
      const firstProduct = this.produtos.find((product) => product.walkin_sellable) || null;
      const hasDraft = Boolean(conv?.draft_id);
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: conv?.draft_payment_method || 'Pix',
        payment_due_on: '',
        fulfillment_mode: conv?.draft_fulfillment_mode || 'delivery',
        delivery_address: conv?.draft_delivery_address || '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: hasDraft ? 'chatwoot_com_bot' : 'chatwoot_sem_bot',
        customer_name: '',
        customer_phone: '',
      };
      this.saleCustomerReset();
      this.saleAddress={structured:!this.modalConv,fields:emptyAddress(),error:''};
      this.orderError = null;
      this.saleModalOpen = true;
    },

    async openWalkinModal() {
      this.saleModalOpen=false;
      this.modalConv = null; this.saleVehicleType = 'all';
      // O estoque pode ter mudado em Compras sem que o shell do painel tenha
      // sido recarregado. A venda sempre abre sobre uma fotografia nova do
      // catálogo para não exibir saldo/custo antigos ao operador.
      try {
        const payload = await this.apiGet('/admin/api/dashboard/produtos?limit=100');
        this.applyProdutos(payload.rows);
      } catch (_error) {
        window.alert('Não consegui atualizar o estoque para a venda. Atualize a página e tente novamente.');
        return;
      }
      const firstProduct = this.produtos.find((product) => product.walkin_sellable) || null;
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: 'Dinheiro',
        payment_due_on: '',
        fulfillment_mode: 'pickup',
        delivery_address: '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: 'walkin_balcao',
        customer_name: '',
        customer_phone: '',
      };
      this.saleCustomerReset();
      this.saleAddress={structured:true,fields:emptyAddress(),error:''};
      this.orderError = null;
      this.saleModalOpen = true;
    },

    // ─── LIFECYCLE ──────────────────────────────────
    async setRedePeriod(period) {
      if (this.redePeriod === period) return;
      this.redePeriod = period;
      localStorage.setItem('farejador_rede_period', period);
      await this.loadRedeData();
    },

    updateRedeSalesGoal() {
      const value = Math.max(0, Number(this.redeSalesGoal || 0));
      this.redeSalesGoal = value;
      localStorage.setItem('farejador_rede_sales_goal', String(value));
      this.$nextTick(() => this.renderRedeChart());
    },
  };
};
