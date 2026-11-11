window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.financeiroEntradas=function(){
  let opener=null;
  const parse=value=>{
    const raw=String(value??'').trim().replace(/^R\$\s*/i,'');
    if(/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)||/^\d+(?:,\d{1,2})?$/.test(raw))return Number(raw.replace(/\./g,'').replace(',','.'));
    return /^\d+\.\d{1,2}$/.test(raw)?Number(raw):NaN;
  };
  return {
    finEntrada:{open:false,saving:false,row:null,error:''},finEntradaAviso:'',
    finEntradaAbrir(row=null){
      if(this.adminUser?.role!=='owner'||this.finEntrada.saving)return;
      opener=document.activeElement;
      this.finEntrada={open:true,saving:false,row,error:'',amount:'',kind:'income',category:'servicos',description:'',
        date:this.finHoje(),payment_method:'pix',cash_account:'Caixa principal',key:crypto.randomUUID()};
      this.$nextTick(()=>{document.getElementById(row?'fin-entry-reason':'fin-entry-kind')?.focus();window.lucide?.createIcons();});
    },
    finEntradaFechar(){if(!this.finEntrada.saving){this.finEntrada.open=false;if(opener?.isConnected)opener.focus();}},
    finEntradaFormatarValor(){const value=parse(this.finEntrada.amount);if(Number.isFinite(value))this.finEntrada.amount=value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});},
    async finEntradaSalvar(){
      const f=this.finEntrada;if(f.saving||this.adminUser?.role!=='owner')return;
      const amount=parse(f.amount);
      if((!f.row&&(!Number.isFinite(amount)||amount<=0||amount>999999999.99||f.cash_account.trim().length<2))
        ||f.description.trim().length<3||!f.date||f.date>this.finHoje()){
        f.error='Confira o valor, a descrição, a conta e a data. Informe uma data até hoje e valor com até duas casas decimais.';return;
      }
      const body={occurred_at:this.businessFactInstant(f.date),idempotency_key:f.key};
      if(f.row)body.reason=f.description.trim();
      else Object.assign(body,{kind:f.kind,description:f.description.trim(),amount,payment_method:f.payment_method,
        cash_account:f.cash_account.trim(),...(f.kind==='income'?{category:f.category}:{})});
      f.saving=true;f.error='';
      try{
        await this.apiPost('/admin/api/matriz/financeiro/entries'+(f.row?'/'+f.row.id+'/reverse':''),body);
        f.open=false;opener?.isConnected&&opener.focus();
        this.finEntradaAviso=f.row?'Entrada estornada. O histórico foi preservado.':f.kind==='income'?
          'Receita avulsa registrada no caixa e no resultado.':'Aporte registrado no caixa, sem aumentar o resultado.';
        this.finMes=f.date.slice(0,7);
        if(this.finExtratoFiltro){this.finExtratoFiltro.mes=this.finMes;this.finExtratoFiltro.base='caixa';}
        await Promise.allSettled([this.loadFinanceiro(),this.loadFinExtrato()]);
      }catch(error){
        const code=String(error?.message||'');
        f.error=code.includes('idempotency_conflict')?'Este envio já foi processado com outros dados. Confira o extrato antes de lançar novamente.':
          code.includes('already_reversed')?'Esta entrada já foi estornada. Atualize o extrato.':
          code.includes('date_invalid')?'Não foi possível estornar. Confira se a data é igual ou posterior à entrada original.':
          'Não foi possível registrar. Confira os campos e atualize o extrato antes de tentar outro lançamento.';
      }finally{f.saving=false;}
    },
  };
};
