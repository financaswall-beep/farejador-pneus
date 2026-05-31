# SEÇÕES — Manual do Sistema (construído aos poucos)

Este diretório é o **manual de contratos** do painel do parceiro. Cada arquivo
descreve **uma seção** (Estoque, Frente de caixa, Financeiro, Clientes, etc.):
o que ela é dona, como **ler** dela e como **gravar** nela sem quebrar nada.

## Para que serve

Quando uma seção precisa consultar ou gravar dados de outra (ex.: a Frente de
caixa baixa o Estoque ao vender), ela deve seguir o **contrato** descrito aqui —
e **nunca** mexer direto nas tabelas/colunas de outra seção por fora do contrato.

> Regra de ouro: se não está escrito aqui como fazer, **não improvise** —
> primeiro documente o contrato, depois use.

## Como um doc de seção entra aqui

Uma seção só ganha (ou atualiza) seu manual **quando está funcionando bem e foi
auditada**. Cada doc deve ter, no mínimo:

- **Status** — ✅ estável · 🚧 em obra · ⚠️ funcional com ressalvas
- **Última auditoria** — data (pra saber se o doc pode ter descolado do código)
- **Responsabilidade** — o que a seção faz / não faz
- **Tabelas que possui** — `schema.tabela` + colunas-chave (quem é dono do quê)
- **Endpoints** — método, rota, auth, payload, retorno
- **Como LER** — endpoint/função que outra seção usa pra consultar
- **Como GRAVAR** — endpoint, validações e invariantes
- **Invariantes** — regras que sempre valem (ex.: cancelar venda devolve estoque)
- **⛔ NÃO faça** — armadilhas conhecidas
- **Arquivos-fonte** — caminhos reais (front, back, queries)

Template pronto em [`_TEMPLATE.md`](_TEMPLATE.md).

## Índice

| Seção | Arquivo | Status | Última auditoria |
|---|---|---|---|
| Estoque | [ESTOQUE.md](ESTOQUE.md) | ⚠️ funcional com ressalvas | 2026-05-31 |

_(As próximas seções entram aqui conforme forem auditadas.)_
