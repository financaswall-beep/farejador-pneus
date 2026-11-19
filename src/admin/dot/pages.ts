export function dotPage(requestToken?:string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="dot-request" content="${requestToken??''}"><title>Dot · Matriz 2W</title>
    <script defer src="/admin/dot/consent.js?v=20261117-confirmacao-conversa"></script>
    <style>body{margin:0;background:#f4f7f6;color:#172724;font:18px system-ui,sans-serif}header{background:#1d2b2c;color:white;padding:24px;font-weight:800}
    [hidden]{display:none!important}main{max-width:560px;margin:32px auto;padding:24px;background:white;border:1px solid #d8e4df;border-radius:16px}h1{font-size:30px;margin-top:0}
    p,li{line-height:1.6}button{display:block;width:100%;padding:16px;margin:12px 0;border:1px solid #006044;border-radius:10px;background:#006044;color:white;font:700 18px system-ui;cursor:pointer}
    button.secondary{background:white;color:#006044}button:disabled{opacity:.5;cursor:wait}.connection{padding:16px 0;border-top:1px solid #d8e4df}.error{color:#a3132a}
    @media(max-width:640px){main{margin:16px;padding:20px}}a{color:#006044}</style></head><body>
    <header>2W &nbsp; Matriz</header><main>${requestToken?`<h1>Conectar ao Dot</h1><p>Autorizar <strong>ChatGPT / Work</strong> a consultar os dados da sua Matriz:</p>
    <ul><li>Visão geral, varejo, atacado e relatórios</li><li>Estoque, lotes, catálogo, preços, compras, fornecedores e reposição</li>
    <li>Financeiro completo, caixa, despesas, notas e imagens dos comprovantes</li><li>Histórico de entregas, rotas e retiradas</li>
    <li>Cadastros e operação das lojas parceiras, inclusive seu financeiro</li><li>Clientes, nomes, telefones, endereços, documentos e conversas</li>
    <li>Marketing, textos, comentários e mídia cadastrada</li><li>Equipe, remuneração individual, folha, notificações e saúde do sistema</li></ul>
    <p><strong>Acesso amplo, somente para consulta.</strong> Você autoriza a leitura dos dados pessoais e comerciais acima.
    Nesta etapa, a Milly pode consultar os registros. O conector não envia mensagens a clientes nem executa pagamentos no banco. Senhas, tokens e chaves de integração ficam protegidos.</p>
    <p>Quando você pedir acompanhamento no Dot e o recurso estiver habilitado, o Farejador poderá enviar eventos de conversas e entregas para análise.
    Com o acompanhamento ativo, a Milly pode guardar tarefas e rascunhos internos. Para operações que exigem aprovação, o canal segue a configuração da conexão: conversa ou Matriz. Você pode pedir para parar o acompanhamento ou desconectar abaixo.</p>
    <p>Após conectar, você pode permitir lançamentos financeiros, compras, fornecedores, estoque, catálogo, publicações, alterações de vencimento e cancelamentos de retiradas. Escolha onde confirmar as operações que dependem da sua decisão: por voz ou texto na conversa com a Milly ou na Matriz. As confirmações próprias do ChatGPT continuam sujeitas às regras do aplicativo. A conexão vale por até 30 dias. Você pode desconectar a qualquer momento.</p>
    <button id="allow" type="button">Autorizar consultas</button><button id="deny" class="secondary" type="button">Agora não</button>`:
    `<section id="operation" hidden><h1>Conferir operação da Milly</h1><h2 id="operation-name"></h2><div id="operation-detail"></div><p id="operation-state" role="status"></p><button id="accept-operation" hidden type="button">Autorizar esta operação</button><button id="deny-operation" hidden class="secondary" type="button">Recusar</button></section>
     <section id="review" hidden><h1>Conferir vencimento</h1><p id="review-detail"></p><p id="review-state" role="status"></p><button id="undo-date" class="secondary" hidden type="button">Restaurar vencimento anterior</button></section>
      <section id="manage"><h1>Permissões da Milly</h1><p>A permissão financeira inclui compras e fornecedores. Estoque, catálogo, publicações, vencimentos e cancelamentos de retiradas têm permissões próprias. Você pode escolher uma confirmação por voz ou texto para as operações que dependem da sua decisão, inclusive com acompanhamento ativo.</p><div id="connections"></div></section><a href="/admin/painel">Voltar à Matriz</a>`}
    <p id="message" class="error" role="status" aria-live="polite"></p></main></body></html>`;
}
