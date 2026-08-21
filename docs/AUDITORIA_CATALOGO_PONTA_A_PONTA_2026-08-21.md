# Auditoria do Catálogo — Matriz e parceiro

**Data:** 21/08/2026
**Estado:** aprovado em código, banco descartável e banco-alvo; migration `0197` aplicada e reconciliada; código incorporado à `main`. O runtime novo depende apenas do deploy manual e smoke.

## 1. Escopo

A auditoria percorreu a tela Catálogo da Matriz, APIs, permissões, tabelas e todas as
relações operacionais relevantes: Caixa, Bot da Matriz, Vendas, Compras, Estoque,
Financeiro, Logística, Rede e PDV do parceiro. Foram verificadas também a matemática de
preço, custo, lucro e margem, a preservação histórica e a experiência em desktop e celular.

O Catálogo da Matriz e o preço local do parceiro são fontes deliberadamente separadas:
alterar a tabela da Matriz não muda automaticamente o preço praticado por uma borracharia.
O preço efetivamente fechado continua congelado no item da venda e nunca acompanha uma
alteração posterior de tabela.

## 2. Mapa das relações

| Origem/destino | Contrato confirmado |
|---|---|
| `commerce.products` + `tire_specs` | Identidade comercial do pneu por ambiente, medida, marca e condição |
| `commerce.matriz_product_prices` | Histórico temporal do preço oficial exclusivo da Matriz |
| Catálogo → Caixa da Matriz | Fornece o preço de referência; vendedor pode negociar a venda sem alterar a tabela |
| Catálogo → Bot da Matriz | A busca da Matriz usa o preço oficial da Matriz e só oferece produto vendável |
| Catálogo ↔ Estoque da Matriz | Liga produto ao saldo e custo oficiais por medida, marca e condição; Catálogo não inventa saldo |
| Compras → Estoque → Catálogo | Recebimento pode criar fato físico; produto sem cadastro ou preço continua bloqueado para venda |
| Vendas → Financeiro/Logística | Venda congela descrição, quantidade, preço e custo; mudança futura do Catálogo não reescreve o passado |
| Rede/Bot do parceiro | Continua usando a tabela comercial central da Rede, não o preço exclusivo da Matriz |
| PDV do parceiro | Usa `partner_stock_levels.sale_price`; dono altera a tabela local e funcionário negocia apenas a venda |
| Catálogo da Matriz → parceiro | Pode haver vínculo pelo `product_id`, mas não há propagação silenciosa do preço da Matriz |

Essa separação evita dois erros graves: a Matriz mudar sem querer a margem do parceiro e
uma borracharia alterar o preço oficial da Matriz.

## 3. Problemas confirmados e correções

| Antes | Agora |
|---|---|
| Funcionário via botões de editar/cadastrar/corrigir, embora a API depois recusasse | Tela entra em modo de consulta e métodos do navegador também bloqueiam mutação; API continua exigindo dono |
| Preço com três casas podia chegar ao PostgreSQL e ser arredondado silenciosamente | Tela, API e serviço aceitam somente centavos exatos e auditam o mesmo valor persistido |
| Banco aceitava preço zero enquanto Caixa e vendas exigiam preço positivo | As três fontes — Matriz, Rede e parceiro — exigem preço positivo na API e no banco |
| Serviço era tratado como pneu sem marca/estoque e podia ficar bloqueado incorretamente | Serviço com preço positivo é vendável sem estoque físico, custo de pneu ou compatibilidade de moto |
| Lucro podia usar custo médio com seis casas enquanto a moeda exibida tinha duas | Custo e preço são fechados em centavos antes de lucro e margem |
| Duas variantes equivalentes podiam nascer com grafias como `140/70R17` e `140/70-17` | Banco normaliza medida e “Sem marca” e bloqueia a duplicidade concorrente |
| Janelas de preço sobrepostas ou duas linhas abertas dependiam apenas da disciplina do código | Índices, trava transacional e trigger impedem sobreposição e concorrência |
| Uma linha histórica publicada podia ser alterada ou apagada diretamente | Em produção, só é permitido encerrar uma janela aberta; valor, identidade e linha histórica são imutáveis |
| Compra do parceiro ainda aceitava preço de revenda zero por um caminho secundário | Contrato da compra recusa zero antes de tocar no banco |

A migration aditiva `0197_catalog_integrity.sql` implementa as proteções de banco sem
reescrever pedidos, vendas, custos ou preços existentes.

## 4. Auditoria matemática

Todos os cálculos monetários operacionais usam inteiros em centavos no ponto de decisão.
Exemplo provado pelos testes:

- custo médio físico `82,125000` é exibido e tratado comercialmente como `R$ 82,13`;
- preço `R$ 139,90` gera lucro de `R$ 57,77`;
- margem sobre a venda é `57,77 / 139,90 = 41,2938%`, exibida arredondada;
- preço `139,999` é recusado, não arredondado escondido;
- preço zero, negativo ou não finito nunca torna produto vendável;
- serviço não produz lucro fictício sem uma fonte de custo própria;
- o preço negociado da venda permanece separado do preço tabelado.

A sugestão de preço para margem de 35% usa `custo / (1 - 0,35)` e a entrada final é
arredondada para centavos. Ela é apenas uma ajuda visual; não substitui autorização nem
altera o preço até o dono salvar com motivo.

## 5. Segurança e integridade

- leitura exige sessão administrativa válida;
- cadastrar produto, corrigir marca e alterar preço exigem `owner` no servidor;
- esconder o botão não é a segurança principal: os métodos do navegador e a API também recusam;
- o papel restrito do parceiro não recebe acesso à tabela de preços da Matriz;
- ambiente `prod` não se cruza com `test` nos vínculos auditados;
- funções de guarda usam `SECURITY DEFINER`, `search_path` fixo e execução pública revogada;
- alterações normais de preço criam uma nova linha e `audit.events` com antes, depois, ator e motivo;
- preço já publicado em produção não pode ser apagado nem reaberto.

## 6. Evidência somente leitura do banco-alvo

A leitura foi executada em transação `REPEATABLE READ READ ONLY`, sem alterar dados e sem
expor informações pessoais.

| Controle | Resultado |
|---|---|
| Produtos ativos da Matriz | 6 pneus; 0 serviços; todos os pneus com especificação |
| Catálogo ↔ estoque oficial | 6/6 variantes conciliadas; zero órfão, ambiguidade ou reserva inválida |
| Variantes duplicadas | zero |
| Preços simultâneos ou janelas sobrepostas | zero |
| Preço zero ou moeda divergente entre os vigentes | zero |
| Estoque ativo dos parceiros | 7 itens; 2 vinculados ao catálogo central; zero vínculo inválido |
| Preço local do parceiro | zero nulo/zero entre os itens ativos e estocados |
| Cruzamento indevido de ambiente | zero |
| Bloqueadores para aplicar a `0197`, incluindo dados `test` | zero |

Há uma pendência comercial segura: o produto de teste `TEC-909018-MV` está cadastrado sem
preço vigente. Ele aparece como “Sem preço” e não pode ser vendido até o dono definir o
valor. Isso não é corrupção nem bloqueia a migration; é uma decisão de cadastro pendente.

Das seis linhas históricas de preço ligadas a produtos ativos, quatro possuem evento de
alteração e duas vieram da carga inicial anterior ao fluxo auditado. A `0197` impede novas
reescritas silenciosas; não foram fabricados eventos retroativos.

### Aplicação da `0197` no banco-alvo

- backup: `farejador-prod-pre-0197-20260821-190929.dump`;
- tamanho: **5.018.607 bytes**;
- conteúdo: **2.658 entradas** reconhecidas pelo `pg_restore`;
- SHA-256: `816ad8a423a421dbbf006b2fefbe2e7aba5de6d28dd7eb4db84efc43649a2b99`;
- dry-run integral com `ROLLBACK`: aprovado;
- aplicação em transação única com `COMMIT`: aprovada;
- estado material: 8 triggers, 5 funções, 2 índices e 3 constraints validadas;
- execução pública das funções protegidas: zero;
- reconciliação pós-commit: **8/8 controles zerados**;
- auditoria somente leitura depois do commit: aprovada.

### Publicação

- commit funcional: `a350715226dc02f49895cdb2557fd5ea65f233d6`;
- PR `#72`: aprovada e incorporada;
- CI: run `32532288224`, aprovado em 6m04s;
- `main` após a incorporação: `ab853b3aa8a99030c3d71e0150cfbd77a3d7042b`;
- deploy no Coolify: não iniciado, reservado ao responsável.

## 7. Baterias executadas

| Bateria | Resultado |
|---|---|
| Direcionados de Catálogo, Caixa e parceiro | aprovados; 32 cenários na bateria dirigida principal |
| Unitários completos | **1.267/1.267**, 255 arquivos |
| Integração completa PostgreSQL 17 | **267/267**, 51 arquivos em cinco lotes isolados |
| Integração específica da `0197` | 3/3: duplicidade, preço, janela, permissões e histórico imutável |
| Migrations | **198 verificadas**, última `0197`; replay integral ocorre na inicialização dos bancos descartáveis |
| TypeScript e build | aprovados |
| Paridade e contratos dos painéis | parceiro 597 propriedades; Matriz 1.100; 93 contratos; 240 rotas |
| Fiscal de tamanho | aprovado; nenhum arquivo novo acima de 300 linhas |
| Dependências | `npm audit --audit-level=high`: zero vulnerabilidades |
| Navegador desktop | tabela, filtros, editor, preço/lucro/margem e permissões aprovados |
| Navegador 390×844 | editor sem vazamento horizontal e ações utilizáveis |

## 8. Veredito e sequência operacional

**CATÁLOGO APROVADO EM CÓDIGO, MATEMÁTICA, INTEGRAÇÃO, SEGURANÇA, BANCO DESCARTÁVEL,
BANCO-ALVO E AUDITORIA SOMENTE LEITURA.** As correções de runtime ainda dependem do deploy.

Para declarar a seção implantada ainda é obrigatório:

1. deixar o responsável executar o deploy;
2. fazer smoke autenticado como dono e funcionário na Matriz, e como dono e funcionário no parceiro;
3. testar no runtime uma alteração de preço, uma venda negociada e confirmar que a venda passada não mudou.

Definir preço para `TEC-909018-MV` é opcional para a implantação, mas necessário se esse
produto de teste precisar ser vendido.

## 9. Melhorias sugeridas, não implementadas

- alçada para aprovar preço abaixo de uma margem mínima;
- reajuste em massa com prévia e confirmação por lote;
- agendamento explícito de promoção com início e fim;
- fila de cadastro incompleto para marca/preço/compatibilidade;
- catálogo próprio de serviços com custo e duração configuráveis;
- relatório de margem realizada comparando tabela, negociação e custo efetivo.

Essas ideias não são correções necessárias e ficaram fora desta entrega, conforme solicitado.
