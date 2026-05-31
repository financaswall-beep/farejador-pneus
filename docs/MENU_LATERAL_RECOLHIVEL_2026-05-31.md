# Menu lateral recolhível — Portal Parceiro

> Data: 2026-05-31. Front-only (sem backend, sem migration, sem mudança de cálculo).
> Arquivos: `parceiro/public/app.js`, `parceiro/public/index.html`, `parceiro/public/style.css`.

## Objetivo

Liberar largura de tela (principalmente para a aba **Bate-papo**) recolhendo o menu
lateral de **230px** para **64px** (só ícones).

## Comportamento

- **Botão manual** no rodapé do menu (`«` recolher / `»` expandir) — funciona em
  qualquer tela. O clique do usuário sempre manda.
- **Auto-recolhe ao abrir o Bate-papo** (`goToSection('batepapo')`), pra já dar espaço.
- **Recolhido = só ícones**; o nome aparece como **tooltip no hover**.
- **Persistência:** estado salvo em `localStorage` por unidade
  (`farejador_sidebar_collapsed_<slug>` = `'1'` recolhido / `'0'` expandido).
- **Item ativo:** quando recolhido, cada item vira um quadradinho centralizado (46x46),
  pra o destaque amarelo ficar alinhado com o ícone (não estoura a barra).
- **Rodapé:** ordem Tema → Recolher → **Configurações** (Configurações é o último ícone),
  ancorados no fim da barra por `margin-top:auto` no `.pos-theme-toggle`, com divisor acima.
- **Mobile intacto:** as regras de recolhido são escopadas em `@media (min-width: 769px)`;
  no celular a sidebar continua sendo a barra de abas inferior e o botão de recolher fica
  escondido.

## Onde fica no código

- **Estado:** `sidebarCollapsed` (init a partir do `localStorage`) em `app.js`.
- **Toggle:** método `toggleSidebar()` (flipa + persiste + re-renderiza ícones/gráficos
  porque a largura do conteúdo muda).
- **Auto no chat:** dentro de `goToSection`, ramo `id === 'batepapo'`.
- **Marca no DOM:** `:class="sidebarCollapsed && 'sidebar-collapsed'"` no `.pos-shell`.
- **CSS:** bloco `@media (min-width: 769px) { .pos-shell.sidebar-collapsed { ... } }` em
  `style.css`; botão escondido no mobile via `.pos-sidebar .pos-sidebar-toggle { display:none }`.

## Não faz

- Não mexe em estoque/reserva/financeiro/frente de caixa/pedidos.
- Não altera nenhum cálculo — é só layout/UX.
