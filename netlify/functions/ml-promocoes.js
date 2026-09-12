// API oficial de Promoções do Mercado Livre (/seller-promotions), documentada em
// developers.mercadolivre.com.br/pt_br/gerenciar-ofertas — substitui o script-ponte
// via Tampermonkey (que dependia de cookie de sessão + endpoint interno com
// signature). Usa o mesmo token OAuth Bearer server-side já usado em
// push-estoque.js/ml-item.js, sem precisar de navegador aberto.
//
// Ações (todas usam o token server-side, sem precisar de Authorization do cliente):
//   ?action=user-promotions              -> GET /seller-promotions/users/{seller}
//                                            (todas as campanhas que o vendedor foi convidado)
//   ?action=promotion-items&promotion_id=&promotion_type=&status=candidate
//                                         -> GET /seller-promotions/promotions/{id}/items
//   ?action=item&item_id=                -> GET /seller-promotions/items/{item_id}
//                                            (todas as promoções daquele item, com preço sugerido)
//   POST ?action=apply  body:{item_id, promotion_id, promotion_type, deal_price?, top_deal_price?, start_date?, finish_date?}
//                                         -> POST /seller-promotions/items/{item_id} (aplica de verdade)
//   POST ?action=remove body:{item_id, promotion_id, promotion_type, offer_id?}
//                                         -> DELETE /seller-promotions/items/{item_id} (recusa/remove)
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ML_APP_ID = '6624742243995383';
const SELLER_ID = '1781620508';

function svcHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function obterTokenML() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1&select=refresh_token,access_token,atualizado_em', { headers: svcHeaders() });
  const rows = await res.json();
  const row = rows[0];
  if (!row || !row.refresh_token) throw new Error('Nenhum refresh_token salvo em ml_auth_token');

  if (row.access_token && row.atualizado_em) {
    const idadeMs = Date.now() - new Date(row.atualizado_em).getTime();
    if (idadeMs < 5 * 60 * 60 * 1000) return row.access_token;
  }

  const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, refresh_token: row.refresh_token
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

async function chamarML(accessToken, path, method, body) {
  const res = await fetch('https://api.mercadolibre.com' + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const accessToken = await obterTokenML();

    if (params.action === 'user-promotions') {
      const offset = params.offset || 0;
      const r = await chamarML(accessToken, `/seller-promotions/users/${SELLER_ID}?app_version=v2&offset=${offset}&limit=50`);
      return { statusCode: r.status, headers, body: JSON.stringify(r.data) };
    }

    if (params.action === 'promotion-items') {
      if (!params.promotion_id || !params.promotion_type) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'promotion_id e promotion_type obrigatórios' }) };
      }
      let qs = `promotion_type=${encodeURIComponent(params.promotion_type)}&app_version=v2&limit=${params.limit || 50}`;
      if (params.status) qs += `&status=${encodeURIComponent(params.status)}`;
      if (params.search_after) qs += `&search_after=${encodeURIComponent(params.search_after)}`;
      const r = await chamarML(accessToken, `/seller-promotions/promotions/${params.promotion_id}/items?${qs}`);
      return { statusCode: r.status, headers, body: JSON.stringify(r.data) };
    }

    if (params.action === 'item') {
      if (!params.item_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'item_id obrigatório' }) };
      const r = await chamarML(accessToken, `/seller-promotions/items/${params.item_id}?app_version=v2`);
      return { statusCode: r.status, headers, body: JSON.stringify(r.data) };
    }

    if (params.action === 'apply' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { item_id, promotion_id, promotion_type, deal_price, top_deal_price, start_date, finish_date } = body;
      if (!item_id || !promotion_id || !promotion_type) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'item_id, promotion_id e promotion_type obrigatórios' }) };
      }
      const payload = { promotion_id, promotion_type };
      if (typeof deal_price === 'number') payload.deal_price = deal_price;
      if (typeof top_deal_price === 'number') payload.top_deal_price = top_deal_price;
      if (start_date) payload.start_date = start_date;
      if (finish_date) payload.finish_date = finish_date;
      const r = await chamarML(accessToken, `/seller-promotions/items/${item_id}?app_version=v2`, 'POST', payload);
      return { statusCode: r.status, headers, body: JSON.stringify(r.data) };
    }

    if (params.action === 'remove' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { item_id, promotion_id, promotion_type, offer_id } = body;
      if (!item_id || !promotion_id || !promotion_type) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'item_id, promotion_id e promotion_type obrigatórios' }) };
      }
      let qs = `promotion_type=${encodeURIComponent(promotion_type)}&promotion_id=${encodeURIComponent(promotion_id)}&app_version=v2`;
      if (offer_id) qs += `&offer_id=${encodeURIComponent(offer_id)}`;
      const r = await chamarML(accessToken, `/seller-promotions/items/${item_id}?${qs}`, 'DELETE');
      return { statusCode: r.status, headers, body: JSON.stringify(r.data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action inválido' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
