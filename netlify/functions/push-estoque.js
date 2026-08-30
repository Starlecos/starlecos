// Empurra a quantidade atual do estoque interno (fonte da verdade) pros
// canais externos. Recebe { sku, ignorar_canal } via POST — ignorar_canal
// é 'mercado_livre' ou 'shopify' quando quem chamou já é o próprio webhook
// daquele canal (esse já se atualiza sozinho quando uma venda acontece lá,
// só precisa avisar o OUTRO canal). Sem ignorar_canal, empurra pros dois
// (usado pela Vendas/Financeiro, onde nenhum canal sabe da mudança sozinho).
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const ML_APP_ID = '6624742243995383';

function svcHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}
function anonHeaders() {
  return { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' };
}

async function obterTokenML() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1&select=refresh_token', { headers: svcHeaders() });
  const rows = await res.json();
  const refreshToken = rows[0] && rows[0].refresh_token;
  if (!refreshToken) throw new Error('Nenhum refresh_token salvo em ml_auth_token');

  const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, refresh_token: refreshToken
    }).toString()
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('Falha ao renovar token ML: ' + JSON.stringify(tokenData));

  await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1', {
    method: 'PATCH', headers: svcHeaders(),
    body: JSON.stringify({ refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, atualizado_em: new Date().toISOString() })
  });
  return tokenData.access_token;
}

async function empurrarML(accessToken, itemId, variationId, quantidade) {
  const path = variationId ? '/items/' + itemId + '/variations/' + variationId : '/items/' + itemId;
  const res = await fetch('https://api.mercadolibre.com' + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ available_quantity: quantidade })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data: res.ok ? null : data };
}

async function obterTokenShopify(store, clientId, clientSecret) {
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString()
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Falha ao obter token Shopify: ' + JSON.stringify(data));
  return data.access_token;
}

async function empurrarShopify(variantId, quantidade) {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const token = await obterTokenShopify(store, clientId, clientSecret);
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  // precisa do inventory_item_id (não é o variant_id) e do location_id —
  // busca ao vivo, não guardamos isso pra não duplicar dado que pode mudar.
  const varRes = await fetch(`https://${store}/admin/api/2024-01/variants/${variantId}.json`, { headers });
  const varData = await varRes.json();
  if (!varRes.ok) return { ok: false, status: varRes.status, data: varData };
  const inventoryItemId = varData.variant.inventory_item_id;

  const locRes = await fetch(`https://${store}/admin/api/2024-01/locations.json`, { headers });
  const locData = await locRes.json();
  if (!locRes.ok || !locData.locations || !locData.locations[0]) return { ok: false, status: locRes.status, data: locData };
  const locationId = locData.locations[0].id;

  const setRes = await fetch(`https://${store}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantidade })
  });
  const setData = await setRes.json();
  return { ok: setRes.ok, status: setRes.status, data: setRes.ok ? null : setData };
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'use POST' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { sku, ignorar_canal } = body;
    if (!sku) return { statusCode: 400, headers, body: JSON.stringify({ error: 'sku obrigatório' }) };

    // Se vier uma quantidade explícita (ex: 0 ao excluir o SKU do estoque),
    // usa ela em vez de ler do banco — depois de excluído não tem mais
    // linha pra ler, e o objetivo ali é zerar nos canais mesmo.
    let quantidade;
    if (typeof body.quantidade === 'number') {
      quantidade = body.quantidade;
    } else {
      const estoqueRes = await fetch(SUPABASE_URL + '/rest/v1/estoque_produtos?sku=eq.' + encodeURIComponent(sku) + '&select=quantidade', { headers: anonHeaders() });
      const estoqueRows = await estoqueRes.json();
      if (!estoqueRows.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'SKU não encontrado no estoque' }) };
      quantidade = estoqueRows[0].quantidade || 0;
    }

    // um SKU pode apontar pra VÁRIOS anúncios no ML (anúncios duplicados
    // reais na conta — mesmo produto, item_id diferente; achado em
    // 30/08/2026 com o par Safari/Pequeno Príncipe). Shopify continua 1:1.
    const mlRes = await fetch(SUPABASE_URL + '/rest/v1/sku_ml_listagens?sku=eq.' + encodeURIComponent(sku) + '&select=ml_item_id,ml_variation_id', { headers: anonHeaders() });
    const mlListagens = await mlRes.json();
    const shopifyRes = await fetch(SUPABASE_URL + '/rest/v1/sku_canal_map?sku=eq.' + encodeURIComponent(sku) + '&select=shopify_variant_id', { headers: anonHeaders() });
    const shopifyRows = await shopifyRes.json();
    const shopifyVariantId = shopifyRows[0] && shopifyRows[0].shopify_variant_id;

    if (!mlListagens.length && !shopifyVariantId) {
      return { statusCode: 200, headers, body: JSON.stringify({ aviso: 'SKU sem mapeamento de canal, nada pra empurrar' }) };
    }

    const resultado = { sku, quantidade, ml: [], shopify: null };

    if (ignorar_canal !== 'mercado_livre' && mlListagens.length) {
      let accessToken;
      try { accessToken = await obterTokenML(); }
      catch (e) { resultado.ml.push({ ok: false, erro: e.message }); accessToken = null; }
      if (accessToken) {
        for (const l of mlListagens) {
          try {
            const r = await empurrarML(accessToken, l.ml_item_id, l.ml_variation_id, quantidade);
            resultado.ml.push({ ml_item_id: l.ml_item_id, ml_variation_id: l.ml_variation_id, ...r });
          } catch (e) {
            resultado.ml.push({ ml_item_id: l.ml_item_id, ml_variation_id: l.ml_variation_id, ok: false, erro: e.message });
          }
        }
      }
    }
    if (ignorar_canal !== 'shopify' && shopifyVariantId) {
      try { resultado.shopify = await empurrarShopify(shopifyVariantId, quantidade); }
      catch (e) { resultado.shopify = { ok: false, erro: e.message }; }
    }

    return { statusCode: 200, headers, body: JSON.stringify(resultado) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
