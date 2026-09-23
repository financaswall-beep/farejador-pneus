# Comprovantes nas despesas do app

O proprietário acessa **Financeiro → Lançar despesa**, pelo Resumo ou Extrato.
Pode fotografar ou escolher JPG/PNG/WebP de até 8 MB. A imagem é validada,
reencodada sem metadados e armazenada privadamente, antes da leitura.

O card **Comprovante** fica abaixo de **Descrição**, com ícones de câmera e
clipe. Depois de anexar, tocar na miniatura abre o resumo da leitura; **Ver foto
original** amplia a imagem. Fechar a foto retorna ao resumo, e **Voltar ao
lançamento** preserva o formulário. Remover o anexo mantém os campos preenchidos.
Dados não identificados são indicados no resumo, permitindo preenchimento manual.

A IA sugere total, categoria, estabelecimento e data. O usuário confere os
campos, escolhe Já paga/A pagar e confirma. Nota fiscal não comprova pagamento.
Erros de leitura permitem nova tentativa ou preenchimento manual com a foto.
Compras de estoque continuam sendo registradas em Compras.

## Ativação

1. Aplicar `0240_expense_receipts.sql` pelo procedimento de migrations do projeto.
2. Publicar o código correspondente.
3. Manter `MATRIZ_EXPENSES=true`. Para leitura automática, usar
   `MATRIZ_RECEIPT_AI=true` e a configuração OpenAI já utilizada pela Logística.
   Sem essa flag, a foto funciona como anexo com preenchimento manual.

Antes da migration, os lançamentos manuais continuam disponíveis e a captura
fica oculta. Não é necessário alterar dados financeiros existentes.

## Integridade

- Usa `createMatrizExpense`, o mesmo motor financeiro do web.
- Despesa, lançamento no livro e vínculo da foto são uma única transação.
- Reenvios conservam a chave de idempotência; a mesma foto não cria outra despesa.
- A deduplicação compara o arquivo reencodado por SHA-256, inclusive entre
  Logística e Financeiro. Fotografias diferentes do mesmo papel não são
  identificadas automaticamente como duplicatas.
- Sugestões e releituras ficam em `analytics`, imutáveis e com versões/proveniência.
  O histórico expõe `superseded_by` sem alterar a leitura anterior.
- Rascunhos são acessíveis ao proprietário. Fotos de despesas salvas seguem
  a permissão do Financeiro, por endpoints autenticados e sem cache público.
- App: consulta pela confirmação, detalhes do Extrato, Contas e Relatórios.
  Web: botão **Comprovante** na lista de Despesas.

Validação automatizada usa API de IA simulada, navegador com dados fictícios
e PostgreSQL descartável. Nenhum documento de produção é enviado nesses testes.
