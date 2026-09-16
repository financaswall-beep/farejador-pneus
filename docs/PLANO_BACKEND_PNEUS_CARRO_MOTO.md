# Carro e moto no backend — análise e proposta

Data: 15/09/2026. Base analisada: código e migrations do repositório, após `97788b0d`.
Status em 16/09/2026: primeiro pacote de fundação implementado e validado localmente (detalhes abaixo). Nenhuma migration aplicada ou dado alterado em produção. O conteúdo atual do banco de produção não foi inventariado.

## Decisão proposta

Usar o mesmo catálogo, compras, estoque, vendas e financeiro. Acrescentar uma classificação explícita do pneu, transportada até os itens das operações e os eventos de procura. Não criar uma segunda operação comercial para carros.

Separar três conceitos:

- Tipo de veículo do pneu: moto, carro ou ainda não identificado.
- Condição do pneu: novo, meia-vida ou remold.
- Compatibilidade: para quais modelos, versões, anos e eixos aquele pneu foi validado.

Classificar um produto como carro não comprova que ele serve em qualquer carro. O tipo também não pode ser propriedade única do cliente, da conversa ou da compra: todos podem envolver carro e moto juntos.

## O que o código mostrou

| Área | Situação e efeito na implementação |
| --- | --- |
| Veículos | `commerce.vehicle_models.vehicle_type` já aceita motorcycle/car/truck. O tipo não é hoje uma dimensão consistente do produto, estoque e relatórios. |
| Catálogo | `queries-catalogo-create.ts` cria o produto e a especificação, mas não recebe carro/moto. A edição técnica também não recebe esse campo. |
| Identidade | A migration 0197 bloqueia duplicatas por medida normalizada + marca + condição. A 0156 usa essa composição no estoque da Matriz. Só acrescentar uma coluna a relatórios não separa dois produtos que colidam nessa identidade. |
| Medidas | `catalog-tire-measure.ts` aceita R, mas retorna medida canônica com hífen. `tire-size.ts` usa grupos numéricos para comparação. Isso ajuda na digitação, mas não preserva construção como identidade técnica. R não pode virar sinônimo de carro. |
| Compatibilidade | `queries-catalogo-create.ts` copia fitments de outro SKU pela dimensão nominal; essa cópia não verifica o tipo de veículo. `queries-catalogo-compatibilidade.ts` restringe cadastro/consulta a motocicletas. |
| Aplicações | `vehicle_measure_applications` tem medida, modelo, anos e posição, mas não tipo de veículo; sua carga e resposta do bot foram feitas para motos. |
| Compras | `purchase-brand.ts` resolve a medida no catálogo; permite marca ainda não pronta para venda. Logo, nem toda linha de compra tem um SKU exato disponível para fornecer sua classificação. |
| Reservas e vendas | `matriz-stock-reservation.ts`, `matriz-stock-source.ts` e o recebimento de compras combinam medida, marca e condição. Cancelamentos usam também os movimentos registrados na reserva. |
| Parceiros | Há estoque livre com vínculo opcional ao produto; `operation-stock-catalog-link.ts` faz o vínculo por medida + marca + condição. Precisa receber a mesma proteção contra mistura. |
| Procura | `ops.bot_stock_searches` é imutável, guarda disponibilidade por loja/medida e não guarda a categoria. Seu observador não grava linha sem produtos/lojas. Já existe registro de procura fora do catálogo em `analytics.conversation_facts`; não deve ser perdido nem duplicado pela expansão. |
| Demanda | A agregação atual deduplica conversa + medida. Pedidos entram inicialmente por conversa, sem categoria do item; apenas filtrar a conversa pode atribuir venda de moto à procura de carro. |
| Relatórios | Compras, vendas, estoque, faltas e demanda possuem APIs existentes, mas sem filtro de tipo de veículo. A projeção de compras também inclui lotes. |
| Serviços | A taxa de instalação retornada pelo bot é por unidade, sem categoria. Não é evidência de que a unidade instala pneus de carro pelo mesmo valor. |

## Modelo de dados e regras

1. **Dado mestre.** Acrescentar `vehicle_type` em `commerce.tire_specs`, usando motorcycle/car e NULL para não identificado. Manter os tipos existentes de `vehicle_models`, sem ampliar atendimento a caminhões por consequência. Não usar default motorcycle. Edição administrativa com motivo e auditoria.
2. **Aplicações e pré-cadastro.** Acrescentar a categoria às aplicações verificadas e ao pré-cadastro de medidas. A medida sozinha pode ser ambígua: o resolvedor deve retornar candidatos, nunca a primeira categoria disponível. Rever as chaves e os leitores do pré-cadastro antes de permitir a mesma dimensão para categorias diferentes.
3. **Identidade operacional.** Categoria precisa participar de todo o caminho quando dois itens puderem compartilhar medida, marca e condição. Atualizar em conjunto unicidade do catálogo/estoque, locks, consolidação de compras, vínculo de parceiros, reserva, baixa e devolução. Não liberar cadastros que criem colisão enquanto algum desses consumidores ainda usar a chave antiga. O identificador de estoque existente deve ser preservado.
4. **Histórico por item.** Registrar categoria em novos itens de compra/venda e movimentos como valor observado naquela operação. Retificação do catálogo não reclassifica silenciosamente todo o passado. Cancelamento devolve ao mesmo saldo de origem; movimentos novos devem identificar o estoque e a categoria. Reservas antigas continuam legíveis, com resolução inequívoca da chave antiga ou erro explícito para conciliação.
5. **Compras sem SKU completo.** Resolver categoria pelo cadastro disponível somente quando inequívoca. Caso contrário, permitir registro explícito da categoria na API e manter pendência de catálogo. O fluxo antigo sem campo continua compatível e deixa desconhecido quando faltar comprovação.
6. **Lotes.** Lote de moto ou carro pode guardar uma classificação explícita, sem obrigar o cadastro de cada pneu. Lote misturado fica como misto/não discriminado, sem inventar quantidades por categoria. Separação de um saldo classificado herda sua categoria. Mistos continuam no total geral e aparecem separados dos totais conhecidos de carro e moto.
7. **Medida versus construção.** Manter a busca tolerante a espaços e separadores. Preservar R/ZR/B, construção e índices técnicos quando informados. A classificação não deve depender dessas letras. Não renomear medidas antigas em massa nesta entrega; conflitos técnicos precisam de validação e não podem ser silenciosamente juntados.

## Bot e procura

- Acrescentar tipo opcional à busca de produtos e tipo confirmado nos resultados. O backend valida o pedido contra o catálogo; uma hipótese do modelo não altera o dado mestre.
- Medida completa e produto inequívoco: continuar a busca comercial sem voltar a pedir modelo/ano só para preencher relatórios.
- Tipo explicitamente pedido incompatível com o produto: não ofertar a outra categoria. Produto desconhecido não vira automaticamente compatível.
- Medida não cadastrada: guardar a procura mesmo sem SKU. Distinguir fora do catálogo, sem estoque observado, erro de consulta e categoria desconhecida.
- Dados interpretados da mensagem ficam em analytics, com fonte, versão, confiança, referência e correções por supersessão. Os dados brutos e normalizados não são alterados pelo modelo.
- Não editar os registros imutáveis de `ops.bot_stock_searches`. Novos registros podem carregar dados adicionais; classificação derivada e correção de registros antigos ficam em uma projeção analítica com proveniência. Preservar deduplicação ao combinar fatos e observações de estoque.
- Chave lógica de procura: ambiente + conversa + medida normalizada + categoria resolvida. Repetição da mesma medida não soma; duas medidas somam duas procuras. Uma classificação que sai de desconhecida para carro não gera uma segunda procura.
- Conversa mista conta uma vez no total geral, embora possa aparecer nos dois filtros. O total de conversas de carro e moto não é necessariamente somável.
- Conversão de carro exige item de carro no pedido válido; pedido apenas de moto não converte a procura de carro. Estoque e dinheiro nunca são inferidos do texto de resposta do bot.
- Preservar as chamadas antigas `moto_modelo`/`moto_ano` enquanto se acrescenta um contrato genérico para veículo/modelo/versão/ano. Atualizar prompt e versão somente junto das ferramentas correspondentes.
- Primeira entrega pode atender carro por medida exata. Reconhecer todos os carros por modelo/ano depende de aplicações comprovadas; não prometer um catálogo automotivo completo nesta mudança. Sem referência, pedir a medida, sem inventá-la.
- Instalação/capacidade da unidade para carro deve ser comprovada por configuração específica antes de reaproveitar uma taxa existente de moto. Entrega e retirada conservam suas regras atuais; expansão não autoriza novas promessas de serviço.

## Contrato dos relatórios, antes do frontend

Acrescentar filtro opcional `vehicle_type=all|motorcycle|car|unknown` às APIs existentes. Ausência do parâmetro equivale a all. Lotes mistos permanecem discriminados como não atribuíveis; não ocultá-los do total. Se houver outras categorias no inventário real, mantê-las em grupo explícito, sem convertê-las em carro/moto.

Aplicar o filtro nos itens antes de agregar indicadores, gráficos, tabelas, comparações e exportações. Evitar joins que multipliquem uma linha por suas várias compatibilidades. Todos deve manter os totais e o comportamento comercial anteriores.

- Compras: quantidade, recebido/trânsito e custo histórico dos itens selecionados. Quantidade de compras é distinta por compra; compra mista pode aparecer em ambos os filtros.
- Vendas: quantidade, receita e custo dos itens; cancelamentos/devoluções seguem as regras atuais. Venda mista continua sendo uma só venda no total geral.
- Estoque: saldo físico, reservado, disponível e reposição sem cruzar categorias.
- Demanda/faltas: mesma regra de deduplicação para aba Bot e Relatórios, com disponibilidade histórica separada do saldo atual.
- Financeiro: reaproveitar os lançamentos atuais. Nenhuma nova receita, despesa ou conta a pagar apenas por classificar o pneu. Pagamento de uma compra mista pertence à compra inteira: não anunciar o valor total pago como se fosse só dos pneus de carro nem inventar rateio de pagamento.

## Sequência de execução recomendada

1. **Inventário somente leitura.** Listar produtos, saldos e pendências; detectar colisões de identidade; identificar quais registros possuem evidência segura. Conferir contagens, reservas e saldos financeiros para comparação. Apresentar o manifesto de classificação antes de aplicar a carga.
2. **Fundação aditiva.** Migrations novas para campos, índices necessários e auditoria; APIs aceitam o novo campo como opcional. Não editar migrations já aplicadas. Não recriar banco/tabelas, mover estoque ou recalcular custo. Carga de dados separada da expansão do schema, sem marcar tudo como moto.
3. **Identidade, operações e histórico.** Ajustar todas as leituras/escritas de estoque e registrar categoria por item. Só permitir colisões entre categorias depois de validar o caminho completo, inclusive estorno e parceiros. Preservar idempotência de operações antigas: reenvio com chave já conhecida não vira compra ou venda nova por causa do campo acrescentado.
4. **Bot, demanda e APIs dos relatórios.** Habilitar classificação e filtros mantendo os contratos antigos. Verificar paridade das respostas sem filtro e comportamento do bot para motos.
5. **Frontend depois.** Só após validar dados e APIs, ligar o filtro da imagem nas telas existentes.

Migrations aditivas permitem manter o frontend atual. Reverter só o código antigo deixa de ser seguro após permitir dois saldos com a mesma chave antiga em categorias diferentes; o plano de implantação precisa marcar esse ponto. Não prometer rollback cego nem exclusão das novas colunas como recuperação.

## Testes de aceitação antes de produção

- Mesmo banco de teste: totais de dinheiro, quantidades e reservas antes/depois da classificação são iguais.
- Compra/venda mista: itens classificados corretamente e documento contado uma vez no total.
- Carro e moto com identidade nominal semelhante: nenhum cruzamento de preço, custo, reserva ou reposição; caminho legado ambíguo é recusado.
- Compra em trânsito, recebimento parcial, fiado, pagamento, cancelamento e devolução mantêm as mesmas regras.
- Reenvio da operação, concorrência e reserva antiga não duplicam nem devolvem ao produto errado.
- Busca repetida = uma procura por medida/categoria; duas medidas = duas procuras; conversa mista = uma conversa geral; apenas a categoria efetivamente comprada converte.
- Fora do catálogo aparece na demanda, erro de consulta não vira falta comprovada, correção de desconhecido não duplica a procura.
- Condição é independente da categoria; pneus de carro novos e meia-vida não se misturam.
- Lotes mistos não ganham divisão fictícia; classificação não altera custo alocado nem financeiro.
- APIs antigas sem filtro e frontend atual seguem funcionando; gráficos/CSV/PDF respeitam os mesmos filtros.
- Separação prod/test, permissões, RLS, auditoria, triggers e imutabilidade continuam válidas.

Primeiro pacote sugerido para implementação: inventário, classificação do catálogo, validações e migrations aditivas, com testes locais. Nenhuma mudança visual ou liberação ampla de compatibilidades de carro nesse pacote.

## Primeiro pacote implementado — 16/09/2026

- Migration `0233_tire_vehicle_classification.sql`: categoria opcional em especificações, aplicações e pré-cadastros; índice e guardas de ambiente/compatibilidade no banco. Sem default, backfill, alteração de estoque ou dinheiro. Mantida a unicidade operacional antiga.
- Criação manual e a partir do estoque aceitam `vehicle_type: motorcycle | car | null`. A API de ficha técnica permite classificar com motivo e auditoria; campo omitido conserva o valor anterior. Classificar não apaga posição e índices técnicos.
- Catálogo aceita filtro `vehicle_type=all|motorcycle|car|unknown`, aplicado também aos contadores. Consultas de modelos e aplicações aceitam a categoria. O contrato antigo continua válido.
- Inventário administrativo em `GET /admin/api/catalog/vehicle-inventory`, restrito ao dono: produtos, tipos associados às compatibilidades e saldos para conferência. Não infere nem grava classificações em massa.
- Proteção de compatibilidades: categoria confirmada incompatível é recusada mesmo por SQL direto; reclassificações não podem contradizer fitments existentes. Carro exige categoria explícita e homologação do SKU, sem copiar aplicações para outra marca apenas pela medida. Novos produtos desconhecidos não herdam fitments automaticamente. Motocicletas classificadas só herdam de fontes da mesma categoria. Fitments legados continuam preservados.
- Fila de pesquisa, promoção e diagnóstico de lacunas respeitam a categoria; a promoção de um SKU de carro não é propagada para outro SKU. Chamadas históricas de aplicações de moto não retornam aplicações explicitamente classificadas como carro.

### Implantação e limites desta etapa

Não há variável de ambiente nova. A migration 0233 deve anteceder a versão do código que lê as colunas novas. Em 16/09/2026 ela foi ensaiada com rollback e aplicada no banco novo de produção de São Paulo, antes do push. Foram verificadas as três colunas e as três guardas; as impressões dos registros existentes de catálogo, aplicações, compatibilidades, estoque e livro financeiro permaneceram iguais dentro da transação. Não foi executada classificação automática dos dados existentes.

A conferência também identificou as migrations anteriores `0231_tire_lot_separation.sql` e `0232_tire_lot_sales.sql` ainda ausentes nesse banco. Elas não são dependências da 0233 e não foram aplicadas neste pacote. A pendência foi resolvida em uma operação posterior autorizada em 16/09/2026, descrita em [APLICACAO_LOTES_0231_0232_2026-09-16.md](APLICACAO_LOTES_0231_0232_2026-09-16.md). A versão máxima do schema não comprova que todas as migrations anteriores foram executadas, sendo necessário conferir o ledger individual.

Esta é a fundação, não a conclusão de toda a expansão: ainda faltam a categoria histórica nos itens de compras/vendas/movimentos/lotes, propagação operacional, filtros nos relatórios comerciais e de demanda e a ferramenta/prompt do bot. Não liberar identidades duplicadas entre categorias antes dessa etapa. Medidas, produtos e aplicações antigos sem classificação permanecem desconhecidos; aplicações antigas precisam de revisão/classificação antes de aparecerem em consultas com categoria explícita. A API de inventário permite preparar essa revisão, sem usar medida, aro ou letra R como prova.

### Validação local

- TypeScript e build passaram.
- 43 testes unitários do catálogo, contratos HTTP, classificação e aplicações passaram.
- 18 testes de integração passaram após replay das 234 migrations: classificação, integridade do catálogo, cadastro/compra, compatibilidades e importação de aplicações.
- Integração executada em PostgreSQL embarcado/PGlite isolado; Docker indisponível nesta máquina. Não foi um ensaio de concorrência contra o PostgreSQL de produção.
- Manifesto de migrations e `git diff --check` passaram. Nenhuma migration anterior foi alterada.
- Os arquivos alterados respeitam o limite de tamanho após separar schemas HTTP, preços e consulta de modelos. A checagem global ainda aponta nove arquivos anteriores fora do limite, nenhum alterado neste pacote.
- Teste visual legado separado: 27 passaram e 1 já falha no HEAD por esperar `app.js?v=20260910-relatorios1`, enquanto o HTML existente usa `20260915-cost1`. Nenhum arquivo de frontend foi alterado nesta entrega.

## Segunda entrega — telas e classificação das operações (16/09/2026)

Implementação local nas telas existentes da Matriz:

- Catálogo: filtro e identificação de carro/moto; classificação no cadastro e edição. A consulta de compatibilidades respeita o tipo explicitamente cadastrado.
- Compras: categoria por item, inclusive compra com itens de ambos os tipos. Lotes admitem carro, moto, misto ou não identificado. O fornecedor e o financeiro continuam sendo os mesmos.
- Estoque: filtros em saldo, reposição, custos, lotes e movimentos; mínimos e disponibilidade da reposição separados por tipo. Entradas e correções preservam a categoria do estoque.
- Vendas: seleção de produtos por tipo e identificação dos itens de atacado/lotes. A operação continua usando os fluxos existentes de reserva, baixa e financeiro.
- Bot: filtros nas consultas de demanda e faltas. Uma conversa mista pode aparecer nos dois filtros; pedidos só de moto não são conversão de carro.
- Relatórios: compras, vendas, estoque, demanda e faltas filtram os itens antes dos totais e exportações; visões salvas conservam o filtro. Em compra mista, pagamento e saldo a pagar do documento não são apresentados como exclusivos da categoria filtrada.

### Banco e publicação

A migration **0234_vehicle_type_operation_snapshots.sql** é necessária **antes de publicar esse frontend e backend**. Acrescenta a categoria observada em novas operações e pesquisas, mantém a classificação histórica imutável e separa as políticas de reposição por categoria. Não reclassifica registros antigos nem modifica quantidades, custos ou lançamentos financeiros. “Não identificado” é um estado real, não sinônimo de moto. Lotes mistos não são rateados artificialmente entre carro e moto.

A categoria das pesquisas é determinada por catálogo explícito, com fallback para medida cadastrada sem SKU; não é deduzida pelo aro ou pela letra R. Repetições da mesma medida na conversa permanecem deduplicadas. A identidade comercial antiga de medida/marca/condição permanece única; esta entrega não libera duas variantes iguais de categorias diferentes.

Não há nova variável de ambiente. A migration foi **aplicada em produção em 16/09/2026, às 02:21 BRT**, após ensaio com rollback e backup direcionado. Schema 234 e checksum conferidos por uma nova conexão. Dados existentes, RLS e permissões preservados. O código desta entrega deve ser publicado em seguida: o novo índice de mínimos de reposição exige o contrato com categoria. Reversão não deve excluir colunas ou registros de operações.

Evidências locais fora do Git: `.codex-tmp/vehicle-0234-applied.json` e backup `.codex-tmp/backups/vehicle-0234-2026-09-16T05-21-41-425Z.json` (SHA-256 `87104724e810a01ae170587ca1bdc75fb63dbde5b37259d163a0c96cdc3f18ce`). Foram conferidas nove colunas novas, oito triggers de captura, o guard do catálogo, a chave de mínimos por categoria e a view de compras. O backup é direcionado às dez tabelas afetadas, não um dump integral.

### Verificação desta entrega

Build, TypeScript, testes unitários de telas/contratos e testes de integração de compras, vendas, classificação, demanda, faltas e lotes. Prévia visual local com produtos fictícios de carro, moto e categoria desconhecida. Foram corrigidos também os loops SVG do histórico de compras, que geravam referências sem escopo no Alpine.

Resultado: **203 testes unitários e 45 testes de integração aprovados**, incluindo os testes do estoque com múltiplas marcas e da procura por medida ainda sem SKU. Manifesto das 235 migrations e `git diff --check` conferidos. A checagem global de tamanho ainda aponta sete arquivos anteriores fora do limite; os arquivos desta entrega respeitam os limites. A prova de paridade estática tem inventário desatualizado (novos métodos, sem métodos removidos), sem alteração automática desse inventário.

Integrações executadas em PostgreSQL embarcado/PGlite isolado com replay das migrations; isso não substitui ensaio de concorrência em PostgreSQL externo. Nenhuma compra, venda, conversa ou alteração de estoque foi criada na produção nesta etapa.
