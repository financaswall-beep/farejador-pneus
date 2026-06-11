/**
 * app.format.js - fabrica `format` do painel do parceiro (obra <=300, passo 1/11).
 * MORA AQUI: mascaras (telefone/CPF/moeda), medida de pneu, datas e deep-links de
 * contato (WhatsApp/Waze/Maps) + helpers puros (num/money/uuid/isSaving/dateKey).
 * VEIO DE: app.js linhas 4306-4443 (commit c0d7913), movido VERBATIM.
 * REGRA: teto de 300 linhas (npm run checar-tamanho). Sem estado proprio: `this`
 * e o objeto UNICO montado por montarParceiroApp() no app.js. NUNCA usar spread
 * pra juntar modulos (executa getter e congela valor) - so getOwnPropertyDescriptors.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.format = () => ({
    // â”€â”€â”€ MÃSCARAS / FORMATAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Telefone: estado guarda apenas dÃ­gitos (max 11). Display Ã© (DD) 9XXXX-XXXX.
    // No submit, vai normalizado pra E.164 (+55DDXXXXXXXXX) via toE164Phone().
    onPhoneInput(value) {
      return String(value || '').replace(/\D/g, '').slice(0, 11);
    },

    formatPhoneDisplay(rawDigits) {
      let d = String(rawDigits || '').replace(/\D/g, '');
      if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
        d = d.slice(2);
      }
      if (d.length === 0) return '';
      if (d.length <= 2) return `(${d}`;
      if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
      if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
    },

    toE164Phone(rawDigits) {
      const d = String(rawDigits || '').replace(/\D/g, '');
      if (!d) return null;
      if (d.length === 10 || d.length === 11) return `+55${d}`;
      // jÃ¡ com 12+ dÃ­gitos: assume que veio com DDI
      return `+${d}`;
    },

    // ── Contato direto no card (entrega/retirada) — deep-links, custo ZERO ──
    // O entregador fala pelo WhatsApp/discador DELE (fora da API oficial da Meta),
    // entao nao gasta janela/modelo. waLink monta o wa.me; os de mapa abrem
    // navegacao no endereco do cliente (Waze ou Google Maps), sem chave/cota.
    waLink(rawPhone, text) {
      const e164 = this.toE164Phone(rawPhone);
      if (!e164) return '#';
      const digits = e164.replace(/\D/g, '');
      const t = text ? `?text=${encodeURIComponent(text)}` : '';
      return `https://wa.me/${digits}${t}`;
    },
    deliveryAddr(sale) {
      return String(sale?.delivery_address || '').trim();
    },
    wazeNavUrl(sale) {
      const addr = this.deliveryAddr(sale);
      if (!addr) return '#';
      return `https://waze.com/ul?q=${encodeURIComponent(addr)}&navigate=yes`;
    },
    mapsNavUrl(sale) {
      const addr = this.deliveryAddr(sale);
      if (!addr) return '#';
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
    },

    cpfDigits(value) {
      return String(value || '').replace(/\D/g, '').slice(0, 11);
    },

    // Moeda BRL: estado guarda Number em reais (ex: 1234.50).
    // Input recebe dÃ­gitos puros, trata como centavos.
    onCurrencyInput(value) {
      const digits = String(value || '').replace(/\D/g, '');
      if (!digits) return 0;
      return Math.round(Number(digits)) / 100;
    },

    formatBRLDisplay(value) {
      const n = this.num(value);
      if (n === 0) return '';
      return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    // Medida de pneu: trÃªs campos numÃ©ricos (largura/perfil-aro) compostos em string canÃ´nica.
    // Banco recebe sempre o formato "WIDTH/ASPECT-RIM" (ex: "90/90-18"), nunca input livre.
    composeTireSize(width, aspect, rim) {
      const w = Number(width || 0);
      const a = Number(aspect || 0);
      const r = Number(rim || 0);
      if (!w || !a || !r) return null;
      return `${w}/${a}-${r}`;
    },

    parseTireSize(value) {
      // Reverte "90/90-18" â†’ { width: 90, aspect: 90, rim: 18 }
      // Aceita tambÃ©m variantes radiais "150/60R17" ou "150/60ZR17" (R extraÃ­do pra rim).
      const empty = { width: null, aspect: null, rim: null };
      if (!value) return empty;
      const match = String(value).toUpperCase().match(/^(\d{2,3})\/(\d{2,3})[-ZR]*(\d{1,2})$/);
      if (!match) return empty;
      return {
        width: Number(match[1]),
        aspect: Number(match[2]),
        rim: Number(match[3]),
      };
    },

    tireSizePreview() {
      // Mostra o formato canÃ´nico em tempo real ao lado do label.
      return this.composeTireSize(
        this.stockForm.tire_width,
        this.stockForm.tire_aspect,
        this.stockForm.tire_rim,
      );
    },

    // â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    num(v) { return Number(v || 0); },

    isSaving(action) {
      return this.saving && this.savingAction === action;
    },

    money(v) {
      return this.num(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },

    uuid() {
      return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    },

    dateKeySaoPaulo(value) {
      if (!value) return '';
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
    },

    formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleDateString('pt-BR');
    },

    formatDateTime(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('pt-BR');
    },
});
