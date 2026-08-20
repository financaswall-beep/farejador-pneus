(function () {
  'use strict';

  const Caixa = window.Caixa;

  Caixa.createCheckoutCatalogView = function (checkout, ui, onQuantityChange) {
    function icon(paths) {
      return Caixa.createSvg(paths);
    }

    function setCatalogState(name) {
      ui.loading.classList.toggle('hidden', name !== 'loading');
      ui.error.classList.toggle('hidden', name !== 'error');
      ui.empty.classList.toggle('hidden', name !== 'empty');
      ui.list.classList.toggle('hidden', name !== 'ready');
    }

    function blockLabel(reason) {
      if (reason === 'catalog_price_missing') return 'Sem preço cadastrado';
      if (reason === 'partner_stock_insufficient') return 'Sem estoque';
      if (reason === 'walkin_stock_insufficient') return 'Sem estoque';
      if (reason === 'walkin_cost_missing') return 'Custo pendente';
      if (reason === 'walkin_stock_ambiguous') return 'Estoque em conferência';
      if (reason === 'walkin_measure_not_found') return 'Estoque não cadastrado';
      return 'Indisponível';
    }

    function productTitle(product) {
      if (product.product_type === 'tire' && product.tire_size) {
        return [product.brand, product.tire_size].filter(Boolean).join(' ');
      }
      return product.product_name;
    }

    function productImage(product) {
      const visual = document.createElement('div');
      visual.className = 'catalog-product-visual';
      if (product.product_type !== 'tire') {
        const service = product.product_type === 'service';
        visual.classList.add(service ? 'catalog-product-visual--service' : 'catalog-product-visual--other');
        visual.appendChild(icon(service
          ? [{ d: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z' }]
          : [{ d: 'm4 7 8-4 8 4-8 4-8-4Z' }, { d: 'M4 7v10l8 4 8-4V7M12 11v10' }]));
        return visual;
      }
      const image = document.createElement('img');
      image.src = product.image_url || '/operacao/catalog-tire.webp';
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', function () {
        if (!image.src.endsWith('/operacao/catalog-tire.webp')) image.src = '/operacao/catalog-tire.webp';
      });
      visual.appendChild(image);
      return visual;
    }

    function quantityControl(product) {
      const current = checkout.cart.get(product.product_id)?.quantity || 0;
      if (!product.sellable) {
        const unavailable = document.createElement('span');
        unavailable.className = 'catalog-unavailable';
        unavailable.textContent = blockLabel(product.block_reason);
        return unavailable;
      }
      if (current === 0) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'catalog-add';
        add.setAttribute('aria-label', 'Adicionar ' + productTitle(product));
        add.textContent = '+';
        add.addEventListener('click', function () { onQuantityChange(product, 1); });
        return add;
      }
      const stepper = document.createElement('div');
      stepper.className = 'catalog-stepper';
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.setAttribute('aria-label', 'Remover uma unidade');
      minus.addEventListener('click', function () { onQuantityChange(product, -1); });
      const amount = document.createElement('strong');
      amount.textContent = String(current);
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.setAttribute('aria-label', 'Adicionar uma unidade');
      plus.addEventListener('click', function () { onQuantityChange(product, 1); });
      stepper.append(minus, amount, plus);
      return stepper;
    }

    function productCard(product) {
      const article = document.createElement('article');
      article.className = 'catalog-product' + (product.sellable ? '' : ' catalog-product--blocked');
      const content = document.createElement('div');
      content.className = 'catalog-product-content';
      const title = document.createElement('strong');
      title.textContent = productTitle(product);
      const name = document.createElement('small');
      name.textContent = product.product_type === 'tire'
        ? product.product_name
        : product.product_type === 'service' ? 'Serviço da unidade' : product.product_name;
      const badge = document.createElement('span');
      badge.className = 'catalog-stock' + (product.sellable ? '' : ' catalog-stock--blocked');
      badge.appendChild(icon(product.product_type === 'service'
        ? [{ d: 'm5 12 4 4L19 6' }]
        : [{ d: 'M4 7 12 3l8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10' }]));
      badge.appendChild(document.createTextNode(product.product_type === 'service'
        ? 'Disponível'
        : product.stock_tracked === false ? 'Sem controle de estoque'
        : product.sellable ? String(product.stock_quantity) + ' em estoque' : blockLabel(product.block_reason)));
      const footer = document.createElement('div');
      footer.className = 'catalog-product-footer';
      const price = document.createElement('b');
      price.textContent = product.price_amount === null ? '—' : Caixa.currency.format(product.price_amount);
      footer.append(price, quantityControl(product));
      content.append(title, name, badge, footer);
      article.append(productImage(product), content);
      return article;
    }

    function renderCatalog(products) {
      checkout.products = products;
      ui.list.replaceChildren();
      products.forEach(function (product) { ui.list.appendChild(productCard(product)); });
      setCatalogState(products.length ? 'ready' : 'empty');
    }

    return {
      productTitle: productTitle,
      renderCatalog: renderCatalog,
      setCatalogState: setCatalogState,
    };
  };

  Caixa.normalizePartnerCatalog = function (rows, type, search) {
    const query = String(search || '').trim().toLowerCase();
    return rows.map(function (row) {
      const productType = row.item_type === 'servico' ? 'service'
        : row.item_type === 'insumo' ? 'other' : 'tire';
      const tracked = row.is_tracked !== false;
      const available = tracked
        ? Math.max(0, Number(row.quantity_on_hand || 0) - Number(row.quantity_reserved || 0))
        : 50;
      const price = row.sale_price === null || row.sale_price === undefined ? null : Number(row.sale_price);
      return {
        product_id: row.stock_id,
        partner_stock_id: row.stock_id,
        product_code: row.local_sku || '',
        product_name: row.item_name || 'Item da unidade',
        product_type: productType,
        brand: row.brand || null,
        tire_size: row.tire_size || null,
        price_amount: price,
        currency: 'BRL',
        stock_quantity: available,
        stock_tracked: tracked,
        image_url: null,
        sellable: price !== null && (productType === 'service' || !tracked || available > 0),
        block_reason: price === null ? 'catalog_price_missing'
          : productType !== 'service' && tracked && available <= 0 ? 'partner_stock_insufficient' : null,
      };
    }).filter(function (product) {
      const typeMatch = product.product_type === type;
      const text = [product.product_code, product.product_name, product.brand, product.tire_size]
        .filter(Boolean).join(' ').toLowerCase();
      return typeMatch && (!query || text.includes(query));
    }).sort(function (a, b) {
      if (a.sellable !== b.sellable) return a.sellable ? -1 : 1;
      return Number(b.stock_quantity || 0) - Number(a.stock_quantity || 0)
        || a.product_name.localeCompare(b.product_name, 'pt-BR');
    });
  };

  Caixa.saleRequestBody = function (checkout, totals) {
    const lines = Array.from(checkout.cart.values());
    if (!Caixa.isPartner()) return {
      customer_name: checkout.customerName,
      customer_phone: checkout.customerPhone || null,
      payment_method: checkout.payment,
      idempotency_key: checkout.idempotencyKey,
      items: lines.map(function (line) {
        return {
          product_id: line.product.product_id,
          quantity: line.quantity,
          unit_price: Number(line.negotiatedPrice),
          reference_unit_price: Number(line.referencePrice),
        };
      }),
    };
    const payment = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' }[checkout.payment] || 'Pix';
    return {
      customer_name: checkout.customerName,
      customer_phone: checkout.customerPhone || null,
      items: lines.map(function (line) {
        return { partner_stock_id: line.product.partner_stock_id, quantity: line.quantity,
          unit_price: Number(line.negotiatedPrice),
          reference_unit_price: Number(line.referencePrice) };
      }),
      payment_method: payment,
      payment_status: 'received',
      receivable_installments: 1,
      fulfillment_mode: 'pickup',
      delivery_address: null,
      received_amount: totals.total,
      discount_amount: 0,
      freight_amount: 0,
      source_tag: 'walkin_balcao',
      idempotency_key: checkout.idempotencyKey,
    };
  };
}());
