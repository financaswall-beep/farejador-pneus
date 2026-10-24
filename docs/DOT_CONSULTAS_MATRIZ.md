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
| `consultar_varejo_matriz` | Histórico de pedidos, situação, itens, descontos e custos congelados |
| `consultar_atacado_matriz` | Vendas, compradores anônimos, medidas e compradores inativos há mais de 30 dias |
| `consultar_movimentos_estoque_matriz` | Entradas, saídas, baixas, contagens e alterações de custo |
| `consultar_lotes_matriz` | Saldo e origem dos lotes, movimentos, separações e vendas |
| `consultar_catalogo_matriz` | Produtos, preços atuais de varejo/atacado, aplicações verificadas e histórico |
| `consultar_compras_matriz` | Compras, recebimentos, parcelas, pedidos, fornecedores por código e custos comparados |
| `consultar_reposicao_matriz` | Mínimo, disponível, entradas previstas e sugestão de reposição |
| `consultar_despesas_matriz` | Despesas operacionais, categorias e metadados de comprovantes |
| `consultar_rotas_matriz` | Rotas, paradas, quilômetros, combustível informado e despesas aprovadas |
| `consultar_retiradas_matriz` | Reservas abertas, chegada, instalação e retiradas concluídas |
| `consultar_rede_matriz` | Cadastro comercial, cobertura, termos, comissões, mensalidades e pedidos da Rede |
| `consultar_candidaturas_matriz` | Solicitações por código, região reconhecida, situação e datas de análise |
| `consultar_clientes_matriz` | Histórico e recompra na Matriz, etapas e oportunidades do atendimento da Rede |
| `consultar_bot_matriz` | Conversão por coorte, demanda, faltas e fila de espera agregada |
| `consultar_marketing_matriz` | Métricas persistidas próprias Meta/Google, atribuição, regiões e situação das publicações |
| `consultar_equipe_matriz` | Desempenho por código e totais mensais de folha/comissão protegidos por população mínima |
| `consultar_relatorios_matriz` | Relatórios JSON paginados de vendas, compras, estoque, financeiro, demanda, Rede e rotas |
| `consultar_notificacoes_matriz` | Pendências atuais; não envia nem marca notificações como lidas |
| `consultar_saude_matriz` | Estado registrado da ingestão, filas, sincronização e conferência financeira |

Vendas vêm da mesma régua do resumo da Matriz: entrega só realizada após entregar; transferência do atacado precisa estar aceita. Valores de vendas são **centavos**; valores financeiros em campos `_brl` são strings em **reais**. Todas as respostas informam ambiente, fuso São Paulo e horário da leitura. O financeiro indisponível ou divergente não vira zero.

São **24 ferramentas para as 21 áreas operacionais autorizadas**. Dados comerciais da Matriz e do seu relacionamento com a Rede. Sem nomes/telefones/endereços de clientes, conversas, fotos, dados bancários, SQL arbitrário, ferramentas de escrita ou despesas/lucro privado dos parceiros. Listas limitadas a 50, com total, página e indicação de truncamento; use `pagina` para continuar quando disponível. Pedidos com mais de 50 itens informam o total e limitam o detalhe. Alertas e resumos automáticos dependem de configuração posterior no Dot; o servidor MCP não inicia notificações.

### Filtros e significado dos dados

- Consultas novas usam `periodo=hoje|7dias|30dias|mes`, `mes=AAAA-MM`, `pagina` e, onde aplicável, `referencia` (UUID) e `medida`. `visao` escolhe o assunto enumerado pela ferramenta. Mês explícito exige `periodo=mes`; mês futuro é recusado. Campos extras, ambiente, SQL e URLs são rejeitados. Filtro incompatível com a visão produz erro, sem inventar uma lista vazia.
- Financeiro usa `mes` e `visao=resumo|a_receber|a_pagar`. Resumo é mensal; contas são a posição atual, com saldo após pagamentos parciais, parcelas e vencimentos, sem beneficiário. A lista de contas a pagar omite a folha individual e preserva o bloqueio de conciliação.
- Estoque, reposição, catálogo e lista de lotes representam a posição atual. Histórico de varejo e compras usa a criação/compra; vendas realizadas e CRM respeitam realização. Balcão confirmado não exige retirada posterior. Transferências em trânsito não viram receita realizada. Ranking de compradores se refere ao período; inativos usa a última compra histórica até a data final.
- Em compras, `referencia` é compra, pedido ou fornecedor conforme a visão. Em Rede, é unidade, exceto mensalidades (parceiro). Em lotes é o lote; em catálogo é o produto, exceto compatibilidade, que usa medida. Metadados de comprovante aceitam referência da rota ou despesa, conforme a origem. Sem filtros de medida para lotes, rotas, equipe, notificações ou saúde.
- Atendimento lê somente a conta `CHATWOOT_ACCOUNT_ID`. Se não estiver configurada, só infere a conta quando há exatamente uma conta não excluída no ambiente; ausência/ambiguidade responde indisponível. Etapas não conhecidas viram `outros`; medidas analíticas precisam ter formato de pneu, impedindo que um telefone em campo livre seja retornado.
- Marketing lê o banco, sem sincronizar ou chamar provedores externos. Meta exige identidade de conta verificada e anúncio próprio; campanha mista exclui anúncios externos/desconhecidos. Google usa campanhas marcadas como próprias. Sem métricas persistidas não significa gasto zero. Legendas, mídia, documentos e URLs permanecem privados.
- Funcionários usam códigos, função e indicadores. Não há salário individual, usuário, benefício individual, nota de pagamento ou cálculo de folha na resposta. Totais de remuneração exigem ao menos três contribuintes efetivos por subtotal; caso contrário ficam indisponíveis. Despesas de funcionário ficam fora da listagem de despesas/categorias; o financeiro mantém seu consolidado.
- Descrições de lotes não são devolvidas pelo campo legado `measure` dos itens. Formas de pagamento usam uma lista de valores reconhecidos, sem repassar texto livre. Notas fiscais são apenas situação/vínculo; foto e texto extraído não são expostos.
- Relatórios reutilizam as mesmas consultas e exportam JSON paginado. Financeiro exige `periodo=mes`; estoque continua posição atual. Não criam arquivos públicos, links de download ou exportação irrestrita. Saúde informa estado observado, sem declarar queda só por ausência de tráfego nem executar reparos.

## Publicar e conectar

1. A fundação exige `0274_dot_readonly_oauth.sql`, já aplicada em produção em 23/10/2026. **Esta expansão não exige migration nova** nem altera pedidos, estoque ou lançamentos comerciais.
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

O cliente é previamente cadastrado; não há DCR nem descoberta de clientes por URL. Os metadados anunciam OAuth e identificação de emissor RFC 9207. O callback estável acima é o documentado para servidores com essa identificação. O conector original foi conectado ao ChatGPT/Work e consultado de verdade. A expansão exige novo deploy e atualização da lista de ferramentas no cliente; testes locais e provas diretas de leitura não confirmam esse deploy.

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

34 testes unitários/contratos relacionados e 17 testes de integração aprovados, incluindo cliente MCP oficial, cinco consultas em banco reconstruído, bloqueio físico de DML, PKCE, CSRF, refresh concorrente/replay, expiração, revogação permanente, isolamento de ambiente, privacidade e logs. Suíte unitária completa: **3.450 aprovados, zero falhas**. Build, typecheck, fiscal de tamanho, pools, paridade do painel e manifesto passaram. Foram atualizados os testes legados para montar o chat compartilhado e avaliar os alertas e rótulos atuais; o baseline incorporou somente as 19 rotas de chat já existentes na main, sem remoção ou alteração de guardas. Audit de produção apontou somente um aviso baixo preexistente do Fastify, sem mudança da sua versão.

Execução unitária repetida em ambiente limpo, sem as variáveis fornecidas pela máquina: 3.450 aprovados. Quatro fixtures agora declaram sua configuração fictícia antes dos imports. O teste histórico de atacado preserva a prova isolada da migration 0267 e depois aplica as migrations seguintes antes de exercitar o código atual; o teste de memória verifica a política atual de telefone para canais que não são WhatsApp. Os oito testes de integração desses dois arquivos passaram.

Validação ampliada de integração: 601 casos passaram; os três casos restantes apontaram duas fixtures desatualizadas. A fixture de fotos agora declara uma loja aberta e fixa somente o relógio de disponibilidade. O contrato de grants foi atualizado para as migrations 0270/0271: remove o INSERT amplo de fotos, já restrito a seis colunas pela 0270, e inclui as duas leituras de solicitações atacadistas sob RLS da 0271. A revisão em banco descartável confirmou 75 grants, role segura e ausência de acesso do parceiro às tabelas OAuth. Nenhuma permissão ou regra de produção foi alterada por esses ajustes. Os testes negativos de grants indevidos por tabela e coluna foram preservados.

Prova direta de leitura em produção: resumo, vendas, estoque e entregas responderam; financeiro retornou `central_ledger_integration_red` porque a conciliação existente apontou uma pendência em varejo e uma em estoque. Nenhum dado comercial foi alterado nessa prova. Corrigir essas pendências é trabalho separado; o conector mantém o bloqueio da fonte financeira.

Migration 0274 aplicada em produção em 23/10/2026 após aprovação explícita do proprietário, pelo executor versionado. Código publicado na branch `codex/dot-readonly-20261023`. O Compose repassa as quatro variáveis do conector e mantém `DOT_MCP_ENABLED=false` por padrão; origem vazia é aceita enquanto desativado. Deploy, ativação no Coolify e conexão real no ChatGPT ainda pendentes.

## Atualização — 24/10/2026

O estado acima é histórico: o conector original foi publicado, ativado e conectado ao ChatGPT/Work. A divergência financeira foi rastreada a uma entrega de demonstração indevidamente concluída; ela foi invalidada com auditoria e sem mudar dinheiro ou estoque, restabelecendo a conciliação. A correção OAuth posterior ignora extensões como `ui_locales`, sem afrouxar cliente, callback, recurso ou PKCE.

A expansão mantém OAuth e limites originais, acrescenta 19 ferramentas (total 24) e atualiza a página de consentimento. O proprietário autorizou expressamente a ampliação neste chat; não se transforma o escopo em acesso arbitrário ao banco. Novas conexões veem a descrição completa. É possível revogar e reconectar pelo controle existente, sem migration.

Validação inclui banco descartável reconstruído, todas as visões SQL, paginação, isolamento de ambiente/conta Chatwoot, venda real de balcão sem `retrieved_at`, lote negociado com desconto, campos livres com sentinelas pessoais, anúncio próprio/externo numa campanha mista, Meta legada sem identidade, subtotais de folha com população pequena e ausência de mudança nos fingerprints do livro, movimentos e auditoria durante as leituras. A suíte OAuth continua exercitando o cliente MCP oficial e a barreira física de escrita.

Prova direta em produção confirmou `transaction_read_only=on` e executou as novas consultas sem erros de schema. Marketing sem métricas persistidas no período respondeu indisponível, sem inventar gasto ou vendas. Nenhuma gravação comercial foi feita nessa prova. O código ampliado ainda precisa ser publicado/deployado e a lista do cliente atualizada; essa prova não altera o servidor em execução.
