export function dotPage(requestToken?:string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="dot-request" content="${requestToken??''}"><title>Dot · Matriz 2W</title>
    <script defer src="/admin/dot/consent.js?v=20261023-dot1"></script>
    <style>body{margin:0;background:#f4f7f6;color:#172724;font:18px system-ui,sans-serif}header{background:#1d2b2c;color:white;padding:24px;font-weight:800}
    main{max-width:560px;margin:32px auto;padding:24px;background:white;border:1px solid #d8e4df;border-radius:16px}h1{font-size:30px;margin-top:0}
    p,li{line-height:1.6}button{display:block;width:100%;padding:16px;margin:12px 0;border:1px solid #006044;border-radius:10px;background:#006044;color:white;font:700 18px system-ui;cursor:pointer}
    button.secondary{background:white;color:#006044}button:disabled{opacity:.5;cursor:wait}.connection{padding:16px 0;border-top:1px solid #d8e4df}.error{color:#a3132a}
    @media(max-width:640px){main{margin:16px;padding:20px}}a{color:#006044}</style></head><body>
    <header>2W &nbsp; Matriz</header><main>${requestToken?`<h1>Conectar ao Dot</h1><p>Autorizar <strong>ChatGPT / Work</strong> a consultar os dados da sua Matriz:</p>
    <ul><li>Vendas realizadas e pendências</li><li>Estoque e reposição</li><li>Entregas e notas aguardando conferência</li><li>Resumo financeiro e contas pendentes</li></ul>
    <p><strong>Acesso somente para consulta.</strong> As respostas não incluem nomes, telefones, endereços ou conversas dos clientes.</p>
    <p>A conexão vale por até 30 dias. Você pode desconectar a qualquer momento.</p>
    <button id="allow" type="button">Autorizar consultas</button><button id="deny" class="secondary" type="button">Agora não</button>`:
    `<h1>Conexões do Dot</h1><p>Acesso de consulta autorizado para o ChatGPT / Work.</p><div id="connections"></div><a href="/admin/painel">Voltar à Matriz</a>`}
    <p id="message" class="error" role="status" aria-live="polite"></p></main></body></html>`;
}
