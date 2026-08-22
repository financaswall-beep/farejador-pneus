# Auditoria ponta a ponta — Marketing

**Data:** 21/08/2026
**Escopo auditado:** Visão geral, Campanhas, detalhe da campanha, Jornadas,
Integrações, Meta Insights, referrals WhatsApp/Messenger/Instagram, atribuição de vendas,
CAPI, lançamento do investimento no Financeiro, permissões, banco e interface responsiva.

## Veredito executivo

O **escopo já implementado do Marketing está aprovado em código, cálculos, segurança,
PostgreSQL descartável, integrações cruzadas e navegador local**. Não houve alteração de
campanha, verba ou classificação automática durante a auditoria.

O módulo inteiro ainda não deve ser chamado de concluído em produção: a migration `0198`
já foi aplicada e reconciliada, mas o runtime novo ainda não foi implantado, existe uma campanha de
produção aguardando classificação humana e as subabas Criativos e Geografia e demanda
continuam como estruturas preservadas, sem funcionalidade operacional. Google Ads e TikTok
também não possuem conector neste módulo.

## O que foi cruzado

| Origem | Relação comprovada |
|---|---|
| Meta Insights | campanha/anúncio por dia, investimento, impressões, cliques e conversa canônica |
| Chatwoot/core | mensagem recebida pertence à mesma conversa usada pelo referral |
| Analytics | cotação, intenção e avanço da jornada só depois da origem rastreável |
| Vendas | pedido realizado conserva a conversa de origem e usa last-click de mensagem em até 7 dias |
| Estoque e parceiro | venda só entra como realizada depois da regra operacional já auditada |
| Financeiro | somente campanha classificada como Matriz gera gasto no livro central |
| CAPI | Purchase sai da outbox, sem participar da transação da venda e sem valor/data inválidos |
| Segurança | rotas do Marketing são exclusivas do dono; parceiro e público não recebem acesso ao schema |

## Correções executadas

1. O gráfico **Ritmo de investimento e conversas** passou a seguir o padrão visual do
   consolidado da Rede: linha/área de investimento, linha tracejada de conversas, duas escalas,
   zero explícito, tooltip conjunto e até sete marcações no eixo de datas.
2. A série agora contém todos os dias do período. Dia sem entrega aparece como zero em vez de
   uma linha que pula silenciosamente o intervalo.
3. Os filtros por dia passaram a fechar à meia-noite de São Paulo. O banco em UTC não desloca
   mais referrals ou vendas das três últimas horas do dia.
4. Visão geral, Campanhas, Jornadas e Integrações ignoram respostas antigas quando o dono troca
   rapidamente período ou canal.
5. A tela de Integrações só mostra coleta, atribuição, lucro e CAPI como saudáveis quando a
   evidência correspondente realmente existe. Sync falho e CAPI em retry não ficam verdes.
6. A fila direta da Meta processa primeiro os eventos antigos, expira pendências após sete dias
   na fila e não marca o staging como casado quando o insert do referral conflitou com outra
   cadeia.
7. Sincronizações abandonadas são fechadas como falha e o banco impede duas execuções Meta
   simultâneas no mesmo ambiente.
8. O banco passou a recusar mensagem ligada à conversa errada, atribuição para outra conversa,
   venda anterior ao clique, venda com sete dias ou mais e casamento Messenger/Instagram
   inconsistente.
9. A taxa de primeira resposta é limitada à população de conversas. Duplicidade de ação da
   Meta não produz mais taxa acima de 100% nem custo por resposta artificialmente baixo.
10. O detalhe de venda deixou de chamar todos os canais de CTWA e identifica WhatsApp,
    Messenger ou Instagram.
11. O payload CAPI recusa data inválida, valor não numérico, zero ou negativo antes do envio.

## Auditoria matemática

- Investimento consolidado é a soma em centavos de `financial_spend` apenas das campanhas
  classificadas como `matrix` quando o enforcement está ativo.
- Custo por conversa = investimento ÷ conversas canônicas; zero conversa devolve nulo.
- CTR = cliques ÷ impressões × 100; CPC e CPM usam os mesmos denominadores da Meta.
- Margem após mídia = margem bruta atribuída − investimento financeiro.
- ROAS = receita atribuída ÷ investimento; CAC = investimento ÷ vendas atribuídas.
- Resposta, não respondidas e investimento sem resposta usam a mesma população, sempre entre
  zero e 100%.
- Venda atribuída precisa compartilhar conversa com o referral e ocorrer no intervalo
  `[captured_at, captured_at + 7 dias)`.

Na leitura somente leitura de produção, campanha e anúncio fecharam com o mesmo total de
**R$ 2.015,66** em 152 linhas de cada nível. O gasto financeiro desejado da Matriz foi
**R$ 181,04** e o livro central continha exatamente **R$ 181,04**: divergência **R$ 0,00**.

## Produção observada sem escrita

- 211 execuções de sync: 205 concluídas, uma falha e cinco antigas presas em `running`;
- 304 insights: 152 de campanha e 152 de anúncio, nove campanhas;
- nove escopos: duas Matriz, seis externas e uma pendente de decisão humana;
- nove referrals: oito WhatsApp e um Messenger;
- uma atribuição ativa e um Purchase CAPI enviado;
- dois eventos raw diretos processados, sem evento esgotado;
- um staging Meta casado e um pendente antigo;
- zero insight sem escopo, zero mistura de conversa, zero atribuição fora da janela e zero
  divergência entre Marketing e o Financeiro.

A `0198` corrigiu os cinco syncs abandonados e o staging antigo ao ser aplicada. A campanha
pendente não é alterada: o dono precisa decidir se ela pertence à Matriz ou é externa.

## Evidência executada

| Bateria | Resultado |
|---|---|
| Unitários completos | **1.273/1.273**, 256 arquivos |
| Integração completa PostgreSQL 17 | **269/269**, 52 arquivos, executados isoladamente |
| Marketing direcionado | **58/58 unitários**; pipeline, multicanal, escopo, ledger e `0198` aprovados |
| Migration `0198` em banco limpo | bloqueios causais, lifecycle e concorrência aprovados |
| Migration `0198` no banco-alvo | backup, dry-run, commit e nove reconciliações aprovados |
| Manifesto de migrations | **199 verificadas**; última `0198`; gap histórico `0071` documentado |
| TypeScript e build | aprovados |
| Navegador desktop e celular | gráfico, troca 7/30 dias, tooltip, responsividade e zero overflow aprovados |
| Segurança | owner-only; sem token no frontend; funções novas sem execução pública/parceiro |

Os logs de encerramento de conexão durante a integração são deliberados: esses cenários
derrubam o PostgreSQL descartável para provar recuperação e isolamento. As asserções passaram.

## Limitações e ideias não implementadas

- Criativos: biblioteca, comparação de anúncios e fadiga criativa.
- Geografia e demanda: procura por medida/cidade cruzada com cobertura e estoque.
- Google Ads e TikTok: conectores próprios, sem simular dados como Meta.
- Alertas operacionais: SLA de sync, staging pendente e custo anormal, sem alterar verba
  automaticamente.
- Recomendações de orçamento: somente explicáveis e aprovadas pelo dono; nenhuma automação de
  investimento foi adicionada nesta auditoria.

## Gate para produção

Concluídos antes da publicação:

1. backup restaurável de **5.030.829 bytes**, 2.658 entradas e SHA-256 validado;
2. dry-run integral com rollback confirmado;
3. aplicação da migration `0198` com commit;
4. reconciliação pós-commit: nove indicadores de inconsistência em zero;
5. prova material: quatro gatilhos, quatro funções, três constraints, um índice exclusivo e
   nenhuma execução concedida a `PUBLIC` ou aos papéis do parceiro.

Restam para o fechamento em produção:

1. publicar o código e executar o deploy manual;
2. smoke autenticado de Visão, Campanhas, detalhe, Jornadas e Integrações;
3. classificar manualmente a campanha pendente;
4. validar a configuração real de Meta/CAPI e um ciclo novo de sync/referral/venda.

Até esses passos, o veredito é **MIGRATION APLICADA E CÓDIGO APROVADO PARA DEPLOY, MAS AINDA
NÃO IMPLANTADO NEM AUTORIZADO COMO MÓDULO TOTALMENTE CONCLUÍDO EM PRODUÇÃO**.
