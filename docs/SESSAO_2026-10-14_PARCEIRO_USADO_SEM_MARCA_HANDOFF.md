# Parceiro: usado sem marca — implementação e migration

Data: 2026-10-14. Base: `58e28d9300e59eba30b519df1e1ed575b552a2e9`.
Worktree: `partner-store-hours`; branch: `codex/bot-confirmation-greetings-20261013`.

## Decisão aprovada

No parceiro, pneu usado (`meia_vida`) pode ser cadastrado por medida, veículo, quantidade e preço de venda, sem marca obrigatória. Novo/remold continuam exigindo marca. Preservar a tela original, letras grandes e controles diretos. A Matriz mantém catálogo, marcas, saldos e preços próprios.

## Implementação

- Formulário original: marca opcional no usado, opção “Sem informar”, sem troca de CSS. Scripts com cache atualizado.
- Cadastro do parceiro mantém preço e saldo por loja; não mescla registros antigos com marca. Concorrência protegida por trava transacional.
- Migration `0273_partner_used_tires.sql`: identidade `partner_generic` por ambiente, veículo e medida. Função restrita ao contexto do parceiro, sem liberar escrita direta no catálogo. Auditoria e bloqueio de preço/saldo central para essa identidade.
- Catálogos, compras e estoque da Matriz excluem a identidade exclusiva do parceiro. Os registros existentes recebem `partner_generic=false`.
- `buscar_produto` por medida inclui candidatos do parceiro quando `PARTNER_STOCK_CONFIRMATION` está ativa. Preço e quantidade vêm do roteamento e do estoque da loja; não são inventados a partir da Matriz.
- Se houver marca pedida, a solicitação no app mostra a marca e exige TENHO para ela. Trocar a marca exige nova consulta. A marca confirmada fica no item do pedido e no contexto/foto, sem converter o saldo misto inteiro para essa marca.
- Criação do pedido e cancelamento mantêm reserva e contrato financeiro existentes.

## Limite explícito

A busca de compatibilidade por modelo de veículo (`buscar_compatibilidade`) ficou inalterada. A revisão automática rejeitou acrescentar ofertas genéricas nesse fluxo por poder alterar resultados e promessas de estoque da Matriz fora do escopo específico autorizado. A alteração rejeitada não foi aplicada. O fluxo novo validado é por medida; não afirmar cobertura automática por modelo.

## Validação concluída

- 3.347 testes unitários aprovados, nenhum pendente ou falhando.
- 30 testes de integração aprovados em PostgreSQL 17 descartável: `partner-used-tires`, `partner-stock-confirmation` e `partner-stock-confirmation-order`.
- Replay de todas as 274 migrations no banco de teste, incluindo 0273.
- Integração exercitou a role restrita, RLS entre lojas, concorrência, marca específica, pedido, reservas, cancelamento e separação da Matriz.
- `npm run typecheck`, `npm run check:migrations`, `npm run prova-painel` e `git diff --check` aprovados.
- O verificador de roteamento do painel estava apontando para módulos antigos. Foi atualizado para `caixa-checkout-submit.js` e o pool padrão injetável, preservando as mesmas verificações de isolamento.
- Prévia renderizada com HTML/JS/CSS reais, dados ilustrativos, rede externa bloqueada: sem erro de JavaScript ou transbordamento horizontal. Fonte da medida: 41,34px na lista e 59,67px no cadastro, peso 900.

Artefatos locais: `C:/Farejador agente/artifacts/partner-used-implemented-20261014/` (`proposta-original.png`, `resultado.json`, `unit-results.json`).

## Migration aplicada; deploy pendente

Em 14/10/2026 o usuário autorizou aplicar a migration e fazer o push. A migration 0273 foi ensaiada com rollback e aplicada em produção às 08:45:36 UTC pelo executor oficial. Banco atual: `beisgivepyfhgcujsqan`, São Paulo, conexão local `.env.novo`. A conexão antiga `aoqtgwzeyznycuakrdhp` foi apenas consultada; não recebeu a migration. Os conectores Supabase recusaram acesso; a execução usou a conexão já configurada no projeto.

Verificação posterior: schema na versão 273; checksum `6673397c7b8c33c2dd5231d371bd5c4de3493409a3076e1510884abb840bd64d` igual ao manifesto; coluna e função novas presentes. As impressões dos saldos/reservas e preços dos parceiros, assim como dos saldos/reservas da Matriz, permaneceram iguais. Evidências locais: `migration-before.json` e `migration-after.json`, no diretório de artefatos citado acima.

O código está preparado para o push autorizado ao `main`. O deploy é manual no Coolify e não foi executado nesta etapa. Depois do deploy, validar com a loja de teste o cadastro sem marca, consulta por medida, TENHO com marca pedida e independência do catálogo da Matriz.

Nenhuma conversa real foi enviada; os dados dos testes ficaram no PostgreSQL descartável. A aplicação em produção alterou o schema, sem consolidar ou alterar estoques existentes. O diretório principal tem alterações alheias: não incluir essas alterações ao preparar o push desta worktree.
