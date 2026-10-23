# Dot: consultas da Matriz

Conector MCP dentro do Farejador, exclusivamente para consultas autorizadas pelo proprietário. Desativado por padrão.

## O que consulta

| Ferramenta | Conteúdo |
|---|---|
| `consultar_resumo_matriz` | Vendas realizadas e contagem de pendências operacionais |
| `consultar_vendas_matriz` | Vendas da Matriz por dia e canal, hoje/7 dias/30 dias/mês |
| `consultar_estoque_matriz` | Estoque físico, reservado, disponível, entradas previstas e reposição |
| `consultar_entregas_matriz` | Pedidos por número, situação, valor e data; notas pendentes |
| `consultar_financeiro_matriz` | Competência mensal, caixa, conciliação e pendências agregadas atuais |

Vendas vêm da mesma régua do resumo da Matriz: entrega só realizada após entregar; transferência do atacado precisa estar aceita. Valores de vendas são **centavos**; valores financeiros em campos `_brl` são strings em **reais**. Todas as respostas informam ambiente, fuso São Paulo e horário da leitura. O financeiro indisponível ou divergente não vira zero.

Somente dados da Matriz. Sem nomes/telefones/endereços de clientes, conversas, fotos, dados bancários, SQL arbitrário ou ferramentas de escrita. Listas limitadas a 50, com total e indicação de truncamento. Alertas e resumos automáticos dependem de configuração posterior no Dot; o servidor MCP não inicia notificações.

## Publicar e conectar

1. Validar e aplicar `0274_dot_readonly_oauth.sql` antes do push/deploy, pelo executor versionado. Nenhuma alteração em pedidos, estoque ou lançamentos comerciais.
2. Publicar o código e configurar no Coolify:

```dotenv
DOT_MCP_ENABLED=true
DOT_MCP_PUBLIC_ORIGIN=https://farejador.smarttecsolutions.com.br
DOT_MCP_CLIENT_ID=farejador-dot
DOT_MCP_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect
```

3. Fazer Deploy no Coolify. Push sozinho não publica.
4. No ChatGPT / Work, adicionar um servidor MCP personalizado como plugin:
   - Nome: **Farejador — Matriz**.
   - URL: `https://farejador.smarttecsolutions.com.br/admin/dot/mcp`.
   - Autenticação OAuth, cliente público com PKCE S256; Client ID `farejador-dot`, sem client secret.
   - Se a interface mostrar outro callback, cadastrar **essa URL HTTPS exata** em `DOT_MCP_REDIRECT_URIS` e redeployar. Não usar curingas.
5. Instalar o plugin pessoal, abrir a conexão e entrar com o login de **proprietário da Matriz**. Conferir o escopo e clicar **Autorizar consultas**. A senha permanece no Farejador.
6. Testar: “Consulte minhas vendas de hoje”, “Quais entregas estão com problema?” e “O que falta conferir na Matriz?”. Testar também uma tentativa de alteração, que deve ser recusada.

O cliente é previamente cadastrado; não há DCR nem descoberta de clientes por URL. Os metadados anunciam OAuth e identificação de emissor RFC 9207. O callback estável acima é o documentado para servidores com essa identificação. Não foi confirmado vínculo numa conta real do ChatGPT apenas por passar nos testes locais.

## Controle de acesso

- Consentimento humano owner, com nonce de uso único ligado à sessão e aos parâmetros. Conta admin, parceiro e token emergencial não autorizam o Dot.
- Tokens opacos exclusivos: código de 2 minutos, acesso de 15 minutos, refresh rotativo e conexão com validade absoluta de 30 dias. Segredos somente por hash no banco.
- Reuso de refresh revoga a família. Reset de senha, revogação ou troca de papel revogam a conexão permanentemente, inclusive se a pessoa for reativada.
- Desconectar em `/admin/dot/connections`, usando o login do proprietário. O endpoint de revogação OAuth também está disponível.
- `DOT_MCP_ENABLED=false` retira todas as rotas do conector após o deploy.
- Leituras comerciais em snapshots PostgreSQL `READ ONLY`; escritas técnicas restritas a OAuth/sessões e logs. Sem chamadas adicionais a LLM.
- Sem lotes JSON-RPC. Limites por IP/conexão, no máximo duas requisições simultâneas por conexão e até metade do pool global, limitado a três. Consultas têm timeout de 15 segundos por statement.
- Logs registram ferramenta, grant, duração e resultado; omitem payload, parâmetros OAuth e credenciais.

Referências: [MCP no ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server), [autenticação e callbacks](https://developers.openai.com/plugins/build/auth).

## Validação de implementação — 23/10/2026

32 testes unitários/contratos relacionados e 17 testes de integração aprovados, incluindo cliente MCP oficial, cinco consultas em banco reconstruído, bloqueio físico de DML, PKCE, CSRF, refresh concorrente/replay, expiração, revogação permanente, isolamento de ambiente, privacidade e logs. Build, typecheck, fiscal de tamanho, pools, paridade do painel e manifesto passaram. Suíte unitária geral manteve três falhas anteriores do chat/HTML; o manifesto foi revalidado após atualização do checksum. Audit de produção apontou somente um aviso baixo preexistente do Fastify, sem mudança da sua versão.

Prova direta de leitura em produção: resumo, vendas, estoque e entregas responderam; financeiro retornou `central_ledger_integration_red` porque a conciliação existente apontou uma pendência em varejo e uma em estoque. Nenhum dado comercial foi alterado nessa prova. Corrigir essas pendências é trabalho separado; o conector mantém o bloqueio da fonte financeira.

Migration 0274 aplicada em produção em 23/10/2026 após aprovação explícita do proprietário, pelo executor versionado. Código publicado na branch `codex/dot-readonly-20261023`. O Compose repassa as quatro variáveis do conector e mantém `DOT_MCP_ENABLED=false` por padrão; origem vazia é aceita enquanto desativado. Deploy, ativação no Coolify e conexão real no ChatGPT ainda pendentes.
