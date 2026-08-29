// ==UserScript==
// @name         Starlecos - Ponte de Promoções ML
// @namespace    starlecos
// @version      1.5
// @description  Sincroniza promoções sugeridas pelo Mercado Livre pro Financeiro Starlecos, e aplica as que o Enzo aprovar por lá.
// @match        https://vendedores.mercadolivre.com.br/anuncios/lista/promos*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      pfaounkchpyfhlsdailo.supabase.co
// ==/UserScript==

(function () {
  'use strict';

  const VERSAO = '1.5'; // mostrado no badge — ajuda a confirmar qual versão está rodando de verdade
  const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
  const CICLO_MS = 25000; // 25s entre sincronizações

  // ---------- captura os headers reais que a própria página do ML usa ----------
  // (csrf token e afins são gerados por sessão — em vez de tentar adivinhar de
  // onde vêm, intercepta as chamadas reais que a página faz pra API de
  // promoções — via fetch OU via XMLHttpRequest, não sabemos qual ela usa —
  // e reusa os mesmos headers pras nossas próprias chamadas)
  const headersCapturados = {};
  let urlCapturadaDebug = null;

  function guardarHeader(nome, valor) {
    if (!nome || valor == null) return;
    headersCapturados[String(nome).toLowerCase()] = valor;
  }

  const fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && url.includes('/anuncios/lista/promos/api/')) {
        urlCapturadaDebug = url;
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (h instanceof Headers) h.forEach((v, k) => guardarHeader(k, v));
          else Object.keys(h).forEach(k => guardarHeader(k, h[k]));
        }
      }
    } catch (e) { /* nunca deixa a captura quebrar a página real do ML */ }
    return fetchOriginal.apply(this, arguments);
  };

  const xhrOpenOriginal = XMLHttpRequest.prototype.open;
  const xhrSetHeaderOriginal = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__starlecosUrl = url;
    return xhrOpenOriginal.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (nome, valor) {
    try {
      if (this.__starlecosUrl && String(this.__starlecosUrl).includes('/anuncios/lista/promos/api/')) {
        urlCapturadaDebug = this.__starlecosUrl;
        guardarHeader(nome, valor);
      }
    } catch (e) { /* idem */ }
    return xhrSetHeaderOriginal.apply(this, arguments);
  };

  function headersProntos() {
    return Object.keys(headersCapturados).length > 0;
  }

  function badge(texto) {
    let el = document.getElementById('starlecos-ponte-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'starlecos-ponte-badge';
      el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#111;color:#0f0;font:12px monospace;padding:8px 12px;border-radius:8px;opacity:0.85;max-width:320px;box-shadow:0 2px 10px rgba(0,0,0,.3)';
      document.body.appendChild(el);
    }
    el.textContent = '🔗 Starlecos v' + VERSAO + ': ' + texto;
  }

  // ---------- Supabase via GM_xmlhttpRequest (não sofre CSP da página do ML) ----------
  function sb(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SUPABASE_URL + '/rest/v1/' + path,
        headers: {
          'Content-Type': 'application/json',
          'apikey': ANON_KEY,
          'Authorization': 'Bearer ' + ANON_KEY,
          'Prefer': method === 'POST' ? 'return=minimal,resolution=merge-duplicates' : (method === 'PATCH' ? 'return=minimal' : '')
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(res.responseText ? JSON.parse(res.responseText) : null); }
            catch (e) { resolve(null); }
          } else reject(new Error('Supabase ' + res.status + ': ' + res.responseText));
        },
        onerror: (e) => reject(new Error('Supabase erro de rede: ' + JSON.stringify(e)))
      });
    });
  }

  // ---------- parser da lista (mesma lógica validada em Node contra dado real) ----------
  function encontrarNos(obj, pred, resultados) {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(o => encontrarNos(o, pred, resultados)); return; }
    if (pred(obj)) resultados.push(obj);
    Object.values(obj).forEach(v => encontrarNos(v, pred, resultados));
  }
  function acharUm(obj, pred) {
    if (obj === null || typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) {
      for (const o of obj) { const r = acharUm(o, pred); if (r !== undefined) return r; }
      return undefined;
    }
    if (pred(obj)) return obj;
    for (const v of Object.values(obj)) {
      const r = acharUm(v, pred);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  function paraNumero(txt) {
    if (txt == null) return null;
    return parseFloat(String(txt).replace('R$', '').replace(/\./g, '').replace(',', '.').trim());
  }

  function parseLista(dados) {
    const rowGroups = [];
    encontrarNos(dados, o => o.uiType === 'row_group' && typeof o.id === 'string', rowGroups);

    const extraidos = [];
    for (const rg of rowGroups) {
      const itemIdNum = rg.id.replace('row_group-MLB', '').replace('row_group-', '');
      const itemId = itemIdNum.startsWith('MLB') ? itemIdNum : 'MLB' + itemIdNum;

      const desc = acharUm(rg, o => o.uiType === 'description_refresh');
      const descData = desc ? desc.data : {};
      const titulo = descData.title;
      const precoOriginalTxt = descData.price;
      const foto = (descData.pictures || [])[0];
      const urlProduto = descData.url;

      const promoListNode = acharUm(rg, o => o.promotionList);
      const pl = promoListNode ? promoListNode.promotionList : null;
      const todasCaixas = pl ? [...(pl.promotionBoxes || []), ...(pl.collapsibleRows || [])] : [];

      for (const caixa of todasCaixas) {
        if (caixa.itemStatus !== 'eligible') continue;

        let btnCol = null, chargesCol = null, descontoCol = null, nomeCol = null, precoFinalCol = null;
        for (const col of caixa.columns || []) {
          for (const line of col.lines || []) {
            if (line.type === 'button') btnCol = line;
            if (line.type === 'charges') chargesCol = line;
            if (line.secondaryText && line.primaryText) descontoCol = line;
          }
        }
        nomeCol = caixa.columns?.[0]?.lines?.[1]?.primaryText?.content || caixa.columns?.[0]?.lines?.[0]?.primaryText?.content;
        precoFinalCol = caixa.columns?.[2]?.lines?.[0]?.primaryText?.content;

        if (!btnCol || !btnCol.button) continue;
        const button = btnCol.button;
        const urlCallback = button.urlCallback || '';
        const track = (btnCol.tracks || []).find(t => t.data && t.data.event_data);
        const ev = track ? track.data.event_data : {};

        if (ev.promo_type !== 'tier') continue; // só tier por enquanto — único fluxo validado ponta a ponta

        const params = new URLSearchParams(urlCallback);

        extraidos.push({
          item_id: itemId,
          titulo,
          foto,
          url_produto: urlProduto,
          preco_original: paraNumero(precoOriginalTxt),
          preco_final: paraNumero(precoFinalCol),
          desconto_percentual: descontoCol ? paraNumero(String(descontoCol.secondaryText.content).replace('(', '').replace('%)', '')) : null,
          voce_recebe: chargesCol ? (chargesCol.totalCharges.amount ?? paraNumero(chargesCol.totalCharges.value)) : null,
          promocao_nome: nomeCol,
          promotion_id: ev.promo_id || params.get('promoId'),
          sub_type: ev.promo_sub_type || params.get('subType'),
          card_id_aplicado: ev.card_type || params.get('cardApplied'),
          position: params.get('position') ? parseInt(params.get('position')) : null,
          candidate_quantity: params.get('candidateQuantity') ? parseInt(params.get('candidateQuantity')) : null,
          url_callback: urlCallback,
          detectado_em: new Date().toISOString()
        });
      }
    }
    return extraidos;
  }

  // ---------- busca a lista real (paginada) direto da API do ML ----------
  async function buscarListaCompleta() {
    let todos = [];
    for (let pagina = 1; pagina <= 15; pagina++) {
      const url = 'https://vendedores.mercadolivre.com.br/anuncios/lista/promos/api/items/refresh?page=' + pagina + '&sort=&search=&filters=&tab=promotions&viewId=promos';
      const res = await fetchOriginal(url, { credentials: 'include', headers: headersCapturados });
      if (!res.ok) {
        // sobe o status real (401/403 etc.) pra aparecer no badge — sem isso
        // ficamos cegos sobre se falta CSRF ou é outro problema qualquer
        throw new Error('items/refresh HTTP ' + res.status + ' (página ' + pagina + ')');
      }
      const dados = await res.json();
      const extraidos = parseLista(dados);
      const rowGroupsNaPagina = [];
      encontrarNos(dados, o => o.uiType === 'row_group', rowGroupsNaPagina);
      todos = todos.concat(extraidos);
      if (rowGroupsNaPagina.length === 0) break; // acabaram as páginas
    }
    return todos;
  }

  // ---------- sincroniza a lista pro Supabase (nunca sobrescreve status já decidido) ----------
  async function sincronizarLista() {
    const itens = await buscarListaCompleta();
    if (!itens.length) return 0;
    // omite status/decidido_em/aplicado_em do payload de propósito: o upsert
    // (merge-duplicates) só atualiza as colunas presentes no corpo, então uma
    // promoção já aprovada/recusada/aplicada não volta pra "pendente" sozinha.
    await sb('POST', 'ml_promocoes?on_conflict=item_id,promotion_id', itens);
    return itens.length;
  }

  // ---------- confere de verdade no ML se a promoção ficou ativa ----------
  // (o confirm-from-modal pode responder 200 sem realmente aplicar nada —
  // já vimos esse tipo de falso-positivo antes nesse projeto, com a escrita
  // de SKU no ML. Não confia só no status HTTP: busca a lista de novo e olha
  // o itemStatus real da promoção pra esse item.
  // IMPORTANTE: promotion_id é o ID da CAMPANHA (ex: "P-MLB17923006"),
  // compartilhado por dezenas de itens diferentes — não é único por item.
  // Por isso o match do item precisa ser EXATO (não .includes(), que já
  // causou um falso-positivo real: pegou o row_group de outro item cujo ID
  // continha os mesmos dígitos como substring).
  function acharCaixaPromo(dados, itemIdExato, promotionId) {
    const rowGroups = [];
    encontrarNos(dados, o => o.uiType === 'row_group' && o.id === ('row_group-' + itemIdExato), rowGroups);
    if (!rowGroups.length) return null;
    const promoListNode = acharUm(rowGroups[0], o => o.promotionList);
    const pl = promoListNode ? promoListNode.promotionList : null;
    const todasCaixas = pl ? [...(pl.promotionBoxes || []), ...(pl.collapsibleRows || [])] : [];
    for (const caixa of todasCaixas) {
      const ids = [];
      acharTodos(caixa, 'promo_id', ids);
      if (ids.includes(promotionId)) return caixa;
    }
    return null;
  }
  function acharTodos(obj, chave, resultados) {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(o => acharTodos(o, chave, resultados)); return; }
    if (Object.prototype.hasOwnProperty.call(obj, chave)) resultados.push(obj[chave]);
    Object.values(obj).forEach(v => acharTodos(v, chave, resultados));
  }
  async function statusRealNoML(itemId, promotionId) {
    // não confia no parâmetro "search" pra filtrar por item (nunca validamos
    // se ele realmente filtra por ID) — busca a lista completa, paginada
    // igual buscarListaCompleta, e casa o item por ID exato.
    for (let pagina = 1; pagina <= 15; pagina++) {
      const url = 'https://vendedores.mercadolivre.com.br/anuncios/lista/promos/api/items/refresh?page=' + pagina + '&sort=&search=&filters=&tab=promotions&viewId=promos';
      const res = await fetchOriginal(url, { credentials: 'include', headers: headersCapturados });
      if (!res.ok) return null; // não deu pra confirmar — trata como incerto
      const dados = await res.json();
      const caixa = acharCaixaPromo(dados, itemId, promotionId);
      if (caixa) return caixa.itemStatus;
      const rowGroupsNaPagina = [];
      encontrarNos(dados, o => o.uiType === 'row_group', rowGroupsNaPagina);
      if (rowGroupsNaPagina.length === 0) break; // acabaram as páginas
    }
    return null; // não achou essa promoção pra esse item em nenhuma página
  }

  // ---------- aplica de verdade as que o Enzo aprovou no Financeiro ----------
  async function aplicarAprovadas() {
    const pendentes = await sb('GET', 'ml_promocoes?status=eq.aprovado&select=*');
    if (!pendentes || !pendentes.length) return 0;

    let aplicadas = 0;
    for (const row of pendentes) {
      const itemIdNum = row.item_id.replace('MLB', '');
      try {
        const modalRes = await fetchOriginal('https://vendedores.mercadolivre.com.br/anuncios/lista/promos/api/modal-ondemand', {
          method: 'POST',
          credentials: 'include',
          headers: { ...headersCapturados, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            urlCallback: row.url_callback,
            itemId: itemIdNum,
            viewId: 'promos',
            actionType: 'create'
          })
        });
        if (!modalRes.ok) throw new Error('modal-ondemand falhou: ' + modalRes.status);
        const modalJson = await modalRes.json();
        const dp = modalJson.data.data.defaultParams;
        const urlCallbackModal = modalJson.data.data.urlCallback;
        // "price" não vem dentro de defaultParams — vem de finalPrice.value
        // (confirmado numa captura real; usar dp.price manda o campo faltando)
        const precoFinal = modalJson.data.data.finalPrice ? modalJson.data.data.finalPrice.value : dp.price;

        const confirmRes = await fetchOriginal('https://vendedores.mercadolivre.com.br/anuncios/lista/promos/api/confirm-from-modal', {
          method: 'POST',
          credentials: 'include',
          headers: { ...headersCapturados, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // corpo alinhado byte-a-byte com uma captura real (DevTools) de
            // um "Participar" que funcionou de verdade — sem cardIdApplied
            // (não existe no corpo real) e sem inventar rankingInfo (vem
            // pronto em defaultParams.rankingInfo, é isso que resolveu o
            // "não foi possível adicionar" que a gente tomava antes)
            resource_elements: {
              itemCbt: dp.itemCbt ?? false,
              listPrice: dp.listPrice,
              promotionId: dp.promotionId,
              suggestedPercentage: dp.suggestedPercentage,
              rankingInfo: dp.rankingInfo,
              position: dp.position,
              candidateQuantity: dp.candidateQuantity,
              tags: dp.tags || [],
              eventIds: [],
              isRealtime: dp.isRealtime ?? false,
              isSmartFallback: dp.isSmartFallback ?? false,
              signature: dp.signature,
              pricePercentage: null,
              pricePrimePercentage: null,
              pricePrime: null,
              price: precoFinal,
              tycChecked: false,
              addItemToCampaignCheck: false,
              recoCampaignId: null
            },
            urlCallback: urlCallbackModal,
            impersonalized: false,
            viewId: 'promos',
            itemId: row.item_id,
            actionType: 'create'
          })
        });
        const confirmTxt = await confirmRes.text();
        if (!confirmRes.ok) {
          throw new Error('confirm-from-modal falhou: ' + confirmRes.status + ' ' + confirmTxt.slice(0, 300));
        }

        // espera um instante e confere de verdade — não confia só no 200
        await new Promise(r => setTimeout(r, 2000));
        const statusReal = await statusRealNoML(row.item_id, row.promotion_id);

        if (statusReal === 'active') {
          await sb('PATCH', 'ml_promocoes?id=eq.' + row.id, { status: 'aplicado', aplicado_em: new Date().toISOString() });
          aplicadas++;
        } else {
          throw new Error('confirm-from-modal respondeu 200 mas status real no ML é "' + statusReal + '" (esperado "active") — resposta: ' + confirmTxt.slice(0, 200));
        }
      } catch (e) {
        await sb('PATCH', 'ml_promocoes?id=eq.' + row.id, { status: 'erro', erro_msg: String(e.message || e).slice(0, 500) });
      }
    }
    return aplicadas;
  }

  // ---------- loop principal ----------
  async function ciclo() {
    const statusHeaders = headersProntos() ? Object.keys(headersCapturados).length + ' header(s) vistos' : 'sem headers de sessão capturados';
    try {
      badge('sincronizando... (' + statusHeaders + ')');
      const n = await sincronizarLista();
      let aplicadas = 0;
      if (headersProntos()) aplicadas = await aplicarAprovadas();
      badge(n + ' promoções sincronizadas' + (aplicadas ? ' · ' + aplicadas + ' aplicada(s) agora' : '') + ' · ' + new Date().toLocaleTimeString('pt-BR'));
    } catch (e) {
      badge('erro (' + statusHeaders + '): ' + String(e.message || e).slice(0, 200));
      console.error('[Starlecos ponte]', e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    badge('iniciando...');
    setInterval(ciclo, CICLO_MS);
    setTimeout(ciclo, 3000); // dá um tempinho pra página real fazer o primeiro fetch e capturarmos os headers
  });
})();
