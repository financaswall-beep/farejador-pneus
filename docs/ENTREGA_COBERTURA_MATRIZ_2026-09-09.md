# Entrega e cobertura da Matriz

Tela em **Bot → Entrega e cobertura**, disponível ao proprietário. Mantém a identidade visual aprovada, sem Mensagens/Histórico e com pausa compacta.

## Comportamento

- Cadastro de entrega, retirada, limite em quilômetros, endereço geocodificado, dias, horários e prazo da Matriz. O frete usa a tabela existente.
- Nada é ativado pela migração: nenhuma configuração inicial é inserida. A operação existente continua até o primeiro salvamento pelo proprietário.
- Configuração salva vale nas próximas consultas e no fechamento do pedido. Pausa e retomada na tela precisam de **Salvar alterações**. Pedidos já criados mantêm seu fluxo.
- O motor original conserva os anéis, a justiça entre parceiros e o desempate. A Matriz só disputa quando a flag de concorrência e o estoque unificado estão ativos e ela está estritamente mais perto de todos os parceiros aptos do anel.
- Com o novo cadastro ativo, a entrega usa proximidade e raio da loja, inclusive entre cidades. Não elimina os cadastros de cidades dos parceiros. Sem distância confirmada, o atendimento solicita localização.
- Falta de parceiro não torna a Matriz uma entrega ilimitada. A Matriz também precisa de cobertura e estoque completo. Pausar entrega preserva retirada quando habilitada.
- As políticas antigas de área, endereço/mapa e prazo da Matriz são substituídas na resposta de `buscar_politica`; horário de funcionamento da loja e políticas dos parceiros permanecem próprios.
- Simulação usa produtos e quantidades selecionados, geocodificação e o mesmo motor do bot. Não grava pedido, reserva ou evento de distribuição; a transação é revertida ao terminar. Consulta de saldo da simulação não bloqueia o estoque. O fechamento mantém a trava transacional existente.
- Controle de versão evita sobrescrita concorrente; auditoria de salvamento é imutável e separada por ambiente.

## Ativação no servidor

1. Aplicar `db/migrations/0223_matriz_delivery_settings.sql` pelo executor normal `scripts/apply-migration-file.cjs`, registrando o checksum no ledger. Fazer isso **antes** de subir a nova versão. A verificação de inicialização exige a migração 0223.
2. Usar `GOOGLE_MAPS_API_KEY` no servidor para geocodificação/distâncias, como no roteamento existente.
3. Configurar **outra chave**, `GOOGLE_MAPS_BROWSER_API_KEY`, para Maps JavaScript API, restrita por HTTP referrers ao domínio do painel e por API. Somente essa chave pública é entregue ao navegador. Sem ela, o painel explica a ausência do mapa; cadastro e simulação continuam independentes da visualização. A simulação exige a chave do servidor.
4. Abrir a tela, conferir endereço real, selecionar limite/dias/horários e simular antes de salvar. Não salvar os valores usados no teste visual como operação real.

O círculo do Google Maps representa linha reta. A decisão usa o mecanismo de distância existente: trajeto quando habilitado/disponível, com fallback em linha reta. O resultado informa quando o endereço geocodificado é aproximado.

## Verificação

- Testes de decisão executam o motor original: Matriz próxima, empate, pausa, limite, justiça entre parceiros, retirada e consumo compartilhado de saldo.
- Integração em PostgreSQL 17 temporário aplica todas as migrações, consulta produtos, testa salvamento concorrente, auditoria imutável e separação dos ambientes. Sem fallback para banco real.
- `scripts/prova-bot-entrega-ui.cjs` exercita o HTML/CSS e os módulos reais com APIs de teste: cadastro, salvamento, pausa/retirada, produtos, simulação, estado desatualizado e tela móvel. Usa Playwright instalado (`PLAYWRIGHT_MODULE`, se necessário) e Edge em modo headless; capturas em `artifacts/bot-entrega/`.
- As capturas têm dados de teste e não representam uma consulta ao Google ou ao estoque em produção.

Em 09/09/2026, a migration `0223` foi aplicada no banco novo de produção em São Paulo. A verificação confirmou `application_schema_state=223`, checksum igual ao manifesto e zero linhas de configuração: nenhuma regra operacional foi ativada automaticamente. O mesmo schema aditivo também ficou disponível no banco antigo de contingência, igualmente sem configuração. O deploy e o primeiro salvamento da tela continuam separados.

Validação final: build e typecheck aprovados, 1.754 testes unitários aprovados, quatro testes de integração com PostgreSQL 17 aprovados e prova de interface desktop/móvel aprovada.

Os verificadores gerais de paridade e tamanho ainda apontam pendências anteriores: nove propriedades e três rotas de Catálogo/Clientes não registradas nos baselines antigos e nove arquivos fora dos limites de tamanho. Nenhuma propriedade ou rota de entrega está pendente no contrato; os arquivos desta alteração ficam dentro dos limites. Essas pendências estão fora do build e dos testes acima.
