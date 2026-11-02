# App da Matriz — Viagens de compra e comprovantes

Implementação local na branch `codex/app-viagens-compra-20261101`, baseada no main `a40b187f` (PR #146, viagem no web). Sem push ou deploy nesta etapa.

## Entrega

- Compras → abas Compras/Viagens, lista com código, fornecedores, totais e custo por pneu.
- Resumo da viagem → compras/gastos de origem, foto do comprovante, vincular despesa existente, fechar/reabrir, editar e excluir somente viagem vazia.
- Nova compra → seletor opcional da viagem e criação de viagem no próprio formulário.
- Novo gasto → câmera, galeria ou preenchimento manual; modalidades Combustível/Alimentação/Pedágio/Mais.
- Conferir gasto → leitura de IA editável, escolha explícita do pagamento e conferência do comprovante.
- Gasto salvo → dados e comprovante do mesmo lançamento financeiro, com retorno à viagem.

Textura de aço, tipografia condensada, botões verdes e ícones seguem as duas propostas aprovadas. Cabeçalho, avatar, sino e menu inferior existentes foram preservados. A primeira etapa da compra foi organizada em campos simples; cadastro de fornecedor e as etapas posteriores continuam no wizard original. Datas adicionais e opções para trocar/remover/reler a foto ficam em “Mais datas”, após a ação principal.

## Contratos preservados

O app chama os mesmos serviços de compras, despesas e etiquetas do web. Os adaptadores novos ficam em `src/admin/caixa/route-purchase-groups.ts`; todas as rotas recebem os guardas de proprietário da Matriz usados por Compras. Ambiente e autor vêm da sessão do servidor.

Vincular/desvincular não altera valores, compras, despesas, estoque ou livro financeiro. Despesas de rota, folha e comissão continuam excluídas pelo serviço central. A viagem não gera rateio, pagamento ou lançamento próprio. Viagens fechadas recusam novos vínculos; compras de uma OC não se dividem entre viagens.

O leitor de comprovantes existente foi reutilizado. Não foi criado outro leitor nem outro armazenamento. A imagem pertence a um único registro de despesa e é consultada pela viagem via endpoint autenticado. Fotos não confirmam pagamento. A inferência não lança despesa; somente a confirmação autenticada usa a transação central que grava despesa, comprovante e vínculo juntos.

As tentativas financeiras mantêm o corpo e a chave idempotente em caso de resposta perdida. A viagem e os campos adicionais ficam bloqueados até a confirmação da mesma tentativa. Rejeição determinística de viagem fechada libera a correção sem lançar nada. Sem disponibilidade de comprovantes, o formulário manual permanece utilizável.

Não há migration nova, dependência nova ou variável nova. A migration **0280**, já aplicada na etapa web, é o pré-requisito. Produção não foi modificada durante esta implementação.

## Provas executadas

- `npm run typecheck`: passou.
- `npm test`: **564 arquivos / 3.734 testes passaram**.
- Integração `expense-receipts.integration.test.ts`: **10/10**, em Postgres descartável. Inclui rollback quando a viagem fecha, comprovante sem vínculo após falha, criação atômica, replay e isolamento prod/test dos metadados da foto.
- `scripts/prova-viagem-compra-test.ts`: **15/15**, com BEGIN/ROLLBACK no banco local. Inclui comparação completa das origens, financeiro e estoque antes/depois de vincular/desvincular.
- `npm run checar-tamanho`: passou; módulos novos abaixo de 300 linhas.
- `node scripts/prova-paridade-matriz.cjs`: manifesto preservado, **3.122 propriedades**.
- `git diff --check`: passou.

No navegador Edge, houve **13 verificações adicionais** com login e APIs reais do preview, apenas contra Postgres local. Nenhum erro JavaScript:

1. Criar viagem pelo formulário.
2. Registrar compra no wizard com `group_id`.
3. Vincular despesa existente e comparar hashes das compras, despesas, estoque e livro financeiro.
4. Upload e sugestão não lançam despesa nem escolhem pagamento.
5. Confirmar um único gasto e consultar o mesmo comprovante pelo Financeiro e pela viagem.
6. Compras R$ 1.000 + gastos R$ 200 / 100 pneus = R$ 12 por pneu.
7. Abrir comprovante em visualizador autenticado.
8. Verificar navegação e ausência de largura excedente em 320, 390, 430 e 768 px.
9. Perder a resposta após commit e repetir com o mesmo corpo/chave sem duplicar.
10. Fechar viagem durante o preenchimento e recusar gasto sem prender tentativa.
11. Criar modalidade no diálogo e devolver seleção ao formulário.
12. Fechar diálogos, trocar de abas e rolar o menu inferior.
13. Preencher manualmente com a fonte de comprovantes indisponível.

**Limite da prova da IA:** somente a inferência foi simulada, com uma sugestão sintética inserida em `analytics` local. Upload, imagem, consulta, vínculo, confirmação, financeiro e resumo usaram os caminhos reais do servidor e do banco. Não houve chamada paga a modelo, mensagem a cliente ou escrita em produção. O leitor original tem sua suíte própria, incluída nos testes.

## Preview e evidências locais

Preview mantido em `http://127.0.0.1:4301/operacao/`, usando banco local `farejador_viagem_20261101`. Os previews anteriores não foram encerrados.

Pasta de evidências: `C:/Farejador agente/.codex-tmp/app-viagens-20261101/`:

- `01-lista-viagens.png`, `02-resumo-viagem.png`, `03-nova-compra.png`, `04-anexar-comprovante.png`, `05-conferir-gasto.png`, `06-gasto-salvo.png`.
- `responsivo-320.png`, `responsivo-430.png`, `responsivo-768.png`.
- `result.json`, `resilience-result.json`, `motor-proof.log`, `integration.log`, `unit-final.log`.
- `proof.cjs` e `resilience.cjs`: roteiros locais que geraram essas evidências. Credenciais do preview ficam em arquivos privados ignorados pelo git, sem serem incluídas neste documento.

Os dados mostrados nas capturas são fictícios. A operação financeira das capturas existe somente no banco local de preview.

## Publicação

Revisar a branch antes de integrar ao main. Não houve push nesta etapa. Depois da integração, o deploy continua manual pelo dono no Coolify. Conferir a etiqueta `20261101-trips1` e as rotas/arquivos do app após publicar.
