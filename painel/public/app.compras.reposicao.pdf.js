window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasReposicaoPdf = function () {
  const clean = (value) => String(value ?? '')
    .replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/•/g, '-').replace(/[^\x00-\xFF]/g, '?');
  const escape = (value) => clean(value)
    .replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const money = (value) => `R$ ${Number(value || 0).toFixed(2).replace('.', ',')}`;
  const text = (value, x, y, size = 9, bold = false, color = '0.08 0.12 0.18') =>
    `${color} rg BT /F${bold ? 2 : 1} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escape(value)}) Tj ET\n`;
  const rect = (x, y, width, height, fill, stroke = null) =>
    `${fill} rg ${stroke ? `${stroke} RG ` : ''}${x} ${y} ${width} ${height} re ${stroke ? 'B' : 'f'}\n`;
  const line = (x1, y1, x2, y2, color = '0.88 0.90 0.91') =>
    `${color} RG 0.6 w ${x1} ${y1} m ${x2} ${y2} l S\n`;
  const fit = (value, length) => {
    const label = clean(value);
    return label.length <= length ? label : `${label.slice(0, Math.max(1, length - 3))}...`;
  };
  const bytes = (binary) => {
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index) & 255;
    }
    return out;
  };

  function pageContent(context, pageRows, pageIndex, pageCount) {
    const { summary, suppliers, generated } = context;
    let out = rect(0, 0, 842, 595, '1 1 1');
    out += rect(0, 515, 842, 80, '0.02 0.25 0.18');
    out += text('FAREJADOR', 30, 562, 17, true, '1 1 1');
    out += text('PLANO DE REPOSIÇÃO', 30, 538, 10, true, '0.63 0.95 0.81');
    out += text(`Gerado em ${generated}`, 580, 558, 9, false, '1 1 1');
    out += text(`Pagina ${pageIndex + 1} de ${pageCount}`, 700, 538, 8, false, '0.80 0.91 0.86');

    const cards = [
      ['Pneus sugeridos', summary.tires], ['Medidas críticas', summary.measures],
      ['Investimento estimado', money(summary.estimated)],
      ['Economia estimada', money(summary.savings)],
    ];
    cards.forEach(([label, value], index) => {
      const x = 30 + index * 197;
      out += rect(x, 454, 183, 46, '0.96 0.98 0.97', '0.82 0.90 0.86');
      out += text(label, x + 12, 481, 7, false, '0.35 0.40 0.43');
      out += text(value, x + 12, 464, 13, true, '0.02 0.31 0.22');
    });

    out += text('NECESSIDADE POR MEDIDA E CONDIÇÃO', 30, 428, 10, true);
    out += rect(30, 398, 550, 23, '0.94 0.96 0.95');
    const headers = [['Medida / condição', 38], ['Saldo', 230], ['Min.', 270],
      ['Comprar', 310], ['Marca sugerida', 365], ['Fornecedor', 455], ['Subtotal', 525]];
    headers.forEach(([label, x]) => { out += text(label, x, 406, 7, true, '0.30 0.35 0.38'); });
    let y = 378;
    for (const row of pageRows) {
      out += text(fit(`${row.measure} / ${context.condition(row.tire_condition)}`, 29), 38, y, 8, true);
      out += text(row.quantity_available, 238, y, 8);
      out += text(row.min_quantity, 278, y, 8);
      out += text(row.planned_quantity, 322, y, 8, true, '0.02 0.31 0.22');
      out += text(fit(row.recommended_brand || 'A definir', 14), 365, y, 8);
      out += text(fit(row.supplier_name || 'A cotar', 16), 455, y, 8);
      const subtotal = row.historical_unit_cost == null ? 'A cotar'
        : money(Number(row.historical_unit_cost) * Number(row.planned_quantity));
      out += text(subtotal, 525, y, 8, true);
      out += line(30, y - 10, 580, y - 10);
      y -= 28;
    }

    out += rect(600, 190, 212, 231, '0.98 0.99 0.99', '0.84 0.89 0.87');
    out += text('DIVISÃO POR FORNECEDOR', 615, 398, 10, true);
    let supplierY = 372;
    for (const group of suppliers.slice(0, 6)) {
      out += text(fit(group.supplier_name, 24), 615, supplierY, 8, true);
      out += text(`${group.quantity} pneus`, 615, supplierY - 14, 7, false, '0.35 0.40 0.43');
      out += text(money(group.estimated), 735, supplierY - 7, 9, true, '0.02 0.31 0.22');
      out += line(615, supplierY - 23, 797, supplierY - 23);
      supplierY -= 35;
    }
    out += text('COMO FOI CALCULADO', 30, 86, 9, true, '0.02 0.31 0.22');
    out += text('Soma marcas da mesma medida e condição. Desconta reservas e pneus em trânsito.', 30, 69, 8);
    out += text('Novo, meia-vida e remold permanecem separados. Marca e fornecedor são referências históricas.', 30, 54, 8);
    out += text('Confirme preço atual, disponibilidade e frete antes de comprar.', 30, 27, 8, true, '0.55 0.30 0.05');
    return out;
  }

  function buildPdf(contents) {
    const objects = [null,
      '<< /Type /Catalog /Pages 2 0 R >>',
      '',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
    const pageIds = [];
    contents.forEach((content, index) => {
      const contentId = 5 + index * 2;
      const pageId = contentId + 1;
      pageIds.push(pageId);
      objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    });
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [0];
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = pdf.length;
      pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) {
      pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return bytes(pdf);
  }

  return {
    comprasReplenishmentPdfBytes() {
      const rows = this.comprasReplenishmentSelectedRows();
      if (!rows.length) return null;
      const chunks = [];
      for (let index = 0; index < rows.length; index += 10) chunks.push(rows.slice(index, index + 10));
      const context = {
        summary: this.comprasReplenishmentSummary(),
        suppliers: this.comprasReplenishmentSuppliers(),
        generated: this.comprasReplenishment.generatedAt
          ? this.formatDateTime(this.comprasReplenishment.generatedAt) : 'agora',
        condition: (value) => this.comprasReplenishmentCondition(value),
      };
      return buildPdf(chunks.map((rowsPage, index) =>
        pageContent(context, rowsPage, index, chunks.length)));
    },
    comprasDownloadReplenishmentPdf() {
      const payload = this.comprasReplenishmentPdfBytes();
      if (!payload) {
        this.comprasReplenishment.error = 'Selecione ao menos uma medida para gerar o PDF.';
        return null;
      }
      const blob = new Blob([payload], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const date = window.FarejadorTime?.businessDate?.()
        || new Date().toISOString().slice(0, 10);
      link.download = `plano-reposicao-${date}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
      return payload;
    },
  };
};
