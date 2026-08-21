# Auditoria ponta a ponta — Rede e Parceiros

**Data:** 21/08/2026
**Escopo:** painel da Rede, cadastro e candidaturas, credenciais, termos comerciais,
roteamento do Bot, app do parceiro, Vendas, Estoque, Financeiro, mensalidades,
comissões, funil e permissões.
**Situação:** correções concluídas; migration `0194` aplicada e reconciliada em
produção após backup validado; publicação do código em andamento; deploy ainda não
executado nesta etapa.

## Veredito executivo

A auditoria anterior provava que a aba lia dados reais, mas deixou riscos em
credenciais, permissões, contabilidade e atribuição do funil. Esses pontos foram
corrigidos nas três camadas: tela, API e banco. A Rede está **aprovada em código,
banco limpo e schema de produção**. A aprovação do runtime novo ainda depende de
publicar o código, fazer o deploy e executar o smoke pós-deploy.

## Relações percorridas

| Origem | Destino | O que foi conferido |
|---|---|---|
| Cadastro/candidatura | Parceiro, unidade e acesso | atomicidade, idempotência, ambiente e exibição única da credencial |
| Administrador | Rotas da Rede | criação, aprovação, recusa, reemissão e termos somente para o dono |
| Termos comerciais | Financeiro | comissão, mensalidade e híbrido com combinações exatas e valores explícitos |
| Bot | Parceiro/Matriz | decisão causal por conversa, estoque, distância, modalidade e fallback |
| Parceiro | Vendas/Estoque | pedido só realiza venda e movimenta saldo conforme o fluxo canônico |
| Parceiro | Financeiro | receita, CMV, despesas, contas, comissão da equipe e mensalidade sem duplicidade |
| Banco | Painel da Rede | competência mensal, períodos curtos, fuso de São Paulo e pendências reais |
| Scheduler | Livro financeiro | reconciliação executada fora das rotas GET, sem leitura que modifica dados |

## Defeitos encontrados e corrigidos

### Segurança, identidade e credenciais

- Cadastro direto de parceiro, aprovação, recusa, reemissão e alteração de termos
  passaram a exigir o papel `owner` na interface e na API.
- O navegador não escolhe mais o `environment`; a API usa o ambiente configurado no
  servidor.
- A criação direta ganhou chave idempotente. Repetir uma resposta após timeout não
  cria outro parceiro nem reapresenta a chave pura.
- A chave inicial passa a ser marcada como consumida quando o dono define usuário e
  senha. O valor bruto não volta a ser uma credencial paralela permanente.
- A recuperação gera um token separado, com hash, uso único e auditoria, preservando
  a mesma conta de proprietário e as sessões válidas. Ela não cria um segundo dono.
- A rota genérica de integridade não permite que um administrador comum descubra o
  resultado sensível de `partner.create`.

### Termos comerciais e cobrança

- Comissão e mensalidade precisam ser informadas explicitamente, inclusive quando
  o valor correto é zero.
- O banco agora recusa combinações impossíveis: modelo por comissão exige percentual
  e não aceita mensalidade; mensal exige mensalidade e percentual nulo; híbrido exige
  os dois.
- O card “A receber da rede” usa o livro real de mensalidades em aberto, sem fabricar
  uma dívida estimada a partir do modelo atual do parceiro.
- Se o livro de comissões estiver indisponível, o painel mostra “Indisponível”; não
  troca silenciosamente por uma estimativa com aparência de valor oficial.
- Consultas GET deixaram de executar reconciliação. A varredura de comissões passou
  para o scheduler de continuidade.

### Matemática e competência

- Despesas espelhadas de contas e compras foram excluídas da soma para impedir dupla
  contagem.
- Contas independentes, despesas diretas, comissões de equipe ainda não fechadas e
  ajustes entram uma única vez e no grupo correto.
- O mês usa `competence_month`; períodos menores usam a data do fato. Venda recente,
  despesa e séries diárias usam o evento correto.
- “Hoje” e as séries diárias usam o calendário `America/Sao_Paulo`; fatos entre 21h
  e 23h59 não saltam para o dia seguinte por causa do UTC do banco.
- Mensalidades continuam aparecendo enquanto estiverem abertas, mesmo que o modelo
  comercial do parceiro seja alterado depois.

### Roteamento e funil

- Foi criada `ops.partner_routing_decisions`, com ambiente, conversa, unidade,
  modalidade e resultado (`partner`, `matrix`, `only_far` ou `unresolved`).
- Cotação, entrega e retirada registram a decisão que realmente ocorreu; o funil não
  tenta mais adivinhar uma loja apenas pelo município.
- Pedidos existentes são ligados à decisão real e fatos sem atribuição permanecem
  visíveis como não resolvidos.
- Unidades sintéticas `zz-teste-*` em produção deixam de receber pedidos da Rede sem
  apagar portal, estoque ou histórico de teste.

## Provas executadas

- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run check:migrations`: 195 migrations verificadas; última `0194`.
- `npm test`: 248 arquivos, 1.244 testes unitários aprovados.
- `npm run test:integration`: 47 arquivos, 258 cenários aprovados em PostgreSQL 17
  descartável criado do zero.
- `npm run prova-painel`: paridade do painel e das 236 rotas, contratos e fiscal de
  tamanho aprovados.
- `npm audit --audit-level=high`: zero vulnerabilidades.
- Navegador local: modal bem formatado, comissão obrigatória inclusive em 0%, replay
  sem chave antiga, reemissão auditada funcional e zero erros no console.
- Produção: backup `farejador-prod-pre-0194-20260821-091320.dump`, 4.994.463 bytes,
  2.624 entradas restauráveis e SHA-256
  `0d594e7c96ec796c1ce6e28c94efa1c7534071136d1a978734fd1e1e6937420a`.
- Migration `0194`: dry-run com rollback e aplicação com commit aprovados; contagens
  de origem preservadas e seis controles de reconciliação em zero.

**Total desta rodada:** 1.502 testes automatizados aprovados, além de build, tipagem,
paridade, auditoria de dependências e prova visual.

## Pendências para aprovação no ambiente

1. ~~Fazer backup do banco de produção.~~ Concluído e validado.
2. ~~Aplicar e reconciliar `0194_network_audit_corrections.sql`.~~ Concluído.
3. Publicar o código em `main` e confirmar o SHA usado pelo Coolify.
4. Executar o deploy pelo responsável.
5. Fazer smoke autenticado de Rede, criação/reemissão, candidaturas, termos,
   comissões, mensalidades, funil e roteamento.
6. Executar auditoria somente leitura para confirmar os dados reais.

## Melhorias sugeridas, não implementadas

- Recebimento parcial e comprovante de acerto de comissão.
- Notificação no sino para candidatura nova e cobrança vencida.
- Exportação contábil da Rede.
- Satisfação do cliente compondo a saúde do parceiro.

Essas melhorias não bloqueiam a correção dos defeitos confirmados e não foram
misturadas ao pacote atual.

## Adendo — cobertura por catálogo oficial (`0195`)

A cobertura de parceiros foi fechada contra erros de digitação. Cadastro direto,
candidatura, aprovação e edição na Matriz e no portal do parceiro agora usam os 92
municípios oficiais do RJ. As cidades selecionadas aparecem como chips removíveis por `×`;
lista vazia, duplicata e município inventado são recusados. A edição preserva bairros das
cidades mantidas, remove somente a cidade excluída, inclui cidade nova como `city` e registra
auditoria somente quando o estado realmente muda.

A proteção existe em três camadas: seletor na interface, schemas no servidor e gatilho no
banco. A migration `0195_network_municipality_catalog.sql` foi ensaiada com rollback e
aplicada em produção depois de backup validado. A reconciliação pós-commit confirmou 92
cidades ativas e zero cobertura inválida, duplicada, inativa ou fora do RJ. A função do
gatilho é `SECURITY DEFINER` com `search_path` fixo; tabela e função não têm privilégio
público.

Provas finais: **1.250 unitários**, **260 integrações**, build, 196 migrations, paridade dos
dois painéis, 93 contratos, 238 rotas e `npm audit` sem vulnerabilidade. Backup:
`farejador-prod-pre-0195-20260821-103305.dump`, 5.005.916 bytes, 2.632 entradas, SHA-256
`35f8aa3cc5fbd13f2c39631bbe3e5a75c68e3b4d15de7fca70f29fe20cb2de1b`.

**Veredito:** cobertura por cidade aprovada para deploy; banco de produção já preparado.
O deploy e o smoke autenticado continuam sob responsabilidade do dono.

Publicação: commit funcional `05c76ea`; PR `#68` aprovada pelo GitHub Actions no run
`32489173112` e incorporada à `main`. SHA final de deploy:
`007f224c10b4923223990b55ed1e8dfcc15bb46b`. O Coolify ainda não foi acionado.
