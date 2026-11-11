# Clientes: varejo, atacado e cadastro padronizado

Plano de execução — 10/11/2026.

1. Preservar as alterações locais e as regras existentes de vendas, VIP, leads, privacidade e permissões.
2. Substituir apenas o cabeçalho de Clientes pelo estilo do Marketing: título, textura discreta e ações.
3. Acrescentar perfil comercial independente do canal de contato, com revisão explícita dos não classificados.
4. Acrescentar cadastro/edição com nome, telefone com DDD, e-mail e documento/endereço opcionais. Validar no servidor e aplicar máscaras no formulário.
5. Guardar os dados revisados em sobreposição comercial, por ambiente/fonte/UUID. Não reescrever contatos do Chatwoot nem dados brutos; não inferir DDD, CPF/CNPJ ou identidade por nome.
6. Formatar os dados antigos na apresentação. Manter valores inválidos visíveis para revisão, sem apagá-los ou completá-los automaticamente.
7. Testar comportamento, autorização, concorrência, isolamento e ausência de alterações em pedidos/estoque/financeiro. Validar build e interface desktop/mobile com dados fictícios.

Ativação: migration aditiva e `MATRIZ_CUSTOMER_REGISTRY=true`. Com a flag desligada, permanecem disponíveis a tela, os filtros e a formatação; novas gravações ficam desativadas. A aplicação da migration e o push foram autorizados em 11/11/2026; o deploy será feito pelo proprietário.

Limite: padronização do módulo de Clientes da Matriz. Os formulários de fornecedores, colaboradores e checkout têm contratos próprios e não são alterados implicitamente.

Rollback: desligar a flag e publicar a versão anterior. Não excluir os cadastros nem as revisões para desfazer a interface.

## Entrega local — 11/11/2026

- Cabeçalho sem imagem, textura baseada no Marketing, resumo comercial e filtro Varejo/Atacado/Não classificados.
- Formulário de criação e revisão na ficha. Novos cadastros exigem perfil explícito; correções preservam os dados originais e as vendas.
- Telefone completo em E.164 no cadastro revisado e máscara de exibição. Números antigos incompletos são sinalizados, sem inventar DDD. CPF/CNPJ têm verificação de dígitos; CEP, UF e e-mail têm validação. Campos opcionais não se tornam obrigatórios por conveniência de interface.
- A formatação dos legados ocorre na apresentação, sem UPDATE em massa. Ingestão Chatwoot e cadastros de checkout mantêm seus contratos atuais.
- Escritas exclusivas do proprietário, mesma origem, auditoria de campos alterados, idempotência na criação e controle de versão na edição. Os dados revisados entram no inventário/portabilidade de privacidade mesmo com a interface desativada.
- Implementação integrada à main `9a023d2c`, preservando o atalho Nova venda e as alterações recentes. A migration preparada no checkout antigo foi numerada definitivamente como `0282_customer_registry.sql` nesta release. Não aplicar a cópia preliminar 0272a.

## Validação da release

Build/typecheck, manifesto (283 migrations), pools, tamanho, paridade do compositor e das 596 rotas aprovados. Suíte unitária completa: **3.800 testes aprovados em 575 arquivos**. Integração de cadastro, ficha e privacidade: **17 testes aprovados** em PostgreSQL descartável. Prova visual e funcional de desktop/mobile aprovada. Os baselines receberam somente as adições de Clientes.

## Aplicação em produção — 11/11/2026

Migration 0282 aplicada no projeto operacional de produção, com ensaio prévio em transação com rollback e confirmação por nova conexão. As três tabelas estão sob RLS, sem acesso para anon, authenticated, service_role ou parceiro. As fontes de cadastro, pedidos, estoque e livro financeiro conferidas permaneceram idênticas dentro da transação. O ledger registra o checksum do arquivo versionado. Nenhum dado antigo foi regravado em massa.

**Deploy não executado.** Antes do deploy manual no Coolify, definir `MATRIZ_CUSTOMER_REGISTRY=true`; o Compose já repassa a variável. Para pausar cadastro/edição, voltar a false sem remover tabelas. O executor `scripts/release-customer-registry.cjs` exige projeto e ambiente explícitos, usa leitura por padrão e --commit protegido para aplicação.
