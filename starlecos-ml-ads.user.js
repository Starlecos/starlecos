// ==UserScript==
// @name         Starlecos - Ponte de Ações Mercado Ads
// @namespace    starlecos
// @version      1.0
// @description  Aplica de verdade no Mercado Ads (pausar/ativar anúncio) as ações que o Enzo aprovar no Financeiro.
// @match        https://vendedores.mercadolivre.com.br/publicidade/product-ads/admin/campaigns*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      pfaounkchpyfhlsdailo.supabase.co
// ==/UserScript==

(function () {
  'use strict';

  const VERSAO = '1.0'; // mostrado no badge — ajuda a confirmar qual versão está rodando de verdade
  const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
  const CICLO_MS = 25000;

  // ---------- captura best-effort de headers de sessão da própria página ----------
  // (não é bloqueante — a lição das Promoções ML foi que a chamada real
  // muitas vezes funciona só com credentials:'include', sem precisar de
  // header extra. Captura o que conseguir, usa se tiver, tenta direto se não)
  const headersCapturados = {};
  function guardarHeader(nome, valor) {
    if (!nome || valor == null) return;
    headersCapturados[String(nome).toLowerCase()] = valor;
  }
  const fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && (url.includes('pa.mercadolivre.com.br') || url.includes('/publicidade/'))) {
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
      if (this.__starlecosUrl && (String(this.__starlecosUrl).includes('pa.mercadolivre.com.br') || String(this.__starlecosUrl).includes('/publicidade/'))) {
        guardarHeader(nome, valor);
      }
    } catch (e) { /* idem */ }
    return xhrSetHeaderOriginal.apply(this, arguments);
  };

  function badge(texto) {
    let el = document.getElementById('starlecos-ads-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'starlecos-ads-badge';
      el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#111;color:#0f0;font:12px monospace;padding:8px 12px;border-radius:8px;opacity:0.85;max-width:320px;box-shadow:0 2px 10px rgba(0,0,0,.3)';
      document.body.appendChild(el);
    }
    el.textContent = '📢 Starlecos v' + VERSAO + ': ' + texto;
  }

  function sb(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SUPABASE_URL + '/rest/v1/' + path,
        headers: {
          'Content-Type': 'application/json',
          'apikey': ANON_KEY,
          'Authorization': 'Bearer ' + ANON_KEY,
          'Prefer': method === 'PATCH' ? 'return=minimal' : ''
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

  // ---------- pausar/ativar: endpoint real, mapeado e testado ----------
  async function pausarOuAtivar(adGroupId, statusNovo) {
    const res = await fetchOriginal('https://pa.mercadolivre.com.br/pa/api/admin-pads/ajax/ads/actions/status', {
      method: 'PUT',
      credentials: 'include',
      headers: { ...headersCapturados, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [String(adGroupId)], status: statusNovo })
    });
    const txt = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + txt.slice(0, 300));
    return txt;
  }

  async function aplicarAprovadas() {
    const pendentes = await sb('GET', 'ml_ads_acoes?status=eq.aprovado&select=*');
    if (!pendentes || !pendentes.length) return 0;

    let aplicadas = 0;
    for (const row of pendentes) {
      try {
        if (row.tipo === 'pausar' || row.tipo === 'ativar') {
          if (!row.ad_group_id) throw new Error('ad_group_id faltando na ação');
          const statusNovo = row.tipo === 'pausar' ? 'paused' : 'active';
          const resposta = await pausarOuAtivar(row.ad_group_id, statusNovo);
          // não confia só no 200 — marca como "aguardando_verificacao" até o
          // Financeiro conferir com dado real (via API pública OAuth, que o
          // script-ponte não tem acesso) no próximo "Buscar Performance"
          await sb('PATCH', 'ml_ads_acoes?id=eq.' + row.id, {
            status: 'aguardando_verificacao',
            aplicado_em: new Date().toISOString(),
            erro_msg: 'resposta do ML: ' + resposta.slice(0, 200)
          });
          aplicadas++;
        } else {
          // orcamento/lance: endpoint real ainda não mapeado — não tenta
          // adivinhar (lição aprendida com as Promoções ML: corpo errado
          // silenciosamente não aplica nada)
          await sb('PATCH', 'ml_ads_acoes?id=eq.' + row.id, {
            status: 'erro',
            erro_msg: 'tipo "' + row.tipo + '" ainda não tem execução automática implementada — aplique manualmente pelo painel do Mercado Ads'
          });
        }
      } catch (e) {
        await sb('PATCH', 'ml_ads_acoes?id=eq.' + row.id, { status: 'erro', erro_msg: String(e.message || e).slice(0, 500) });
      }
    }
    return aplicadas;
  }

  async function ciclo() {
    try {
      badge('verificando fila de ações...');
      const aplicadas = await aplicarAprovadas();
      badge((aplicadas ? aplicadas + ' ação(ões) aplicada(s) agora' : 'nenhuma ação pendente') + ' · ' + new Date().toLocaleTimeString('pt-BR'));
    } catch (e) {
      badge('erro: ' + String(e.message || e).slice(0, 200));
      console.error('[Starlecos ponte Ads]', e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    badge('iniciando...');
    setInterval(ciclo, CICLO_MS);
    setTimeout(ciclo, 3000);
  });
})();
