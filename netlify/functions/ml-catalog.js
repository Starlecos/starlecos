// Lista/lê o catálogo do vendedor no ML — usado pra achar anúncios órfãos
// (existem no ML mas nunca entraram em sku_ml_listagens). Só leitura.
//
// Duas ações via query string:
//   ?action=search&status=active|paused  -> pagina /users/{seller}/items/search,
//     devolve todos os item_id daquele status (offset até 1000 por chamada
//     de busca, que é o limite da API pra esse endpoint).
//   ?action=bulk&ids=ID1,ID2,...         -> multiget /items?ids=... (até 20
//     por chamada), devolve title/status/sub_status/variations de cada um.
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

async function buscarTodosIds(accessToken, status) {
  const ids = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const url = `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?status=${status}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    const data = await res.json();
    if (!res.ok) throw new Error('Erro buscando items status=' + status + ': ' + JSON.stringify(data));
    ids.push(...(data.results || []));
    const total = data.paging ? data.paging.total : ids.length;
    offset += limit;
    if (offset >= total || data.results.length === 0 || offset >= 1000) break;
  }
  return ids;
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const params = event.queryStringParameters || {};
    const accessToken = await obterTokenML();

    if (params.action === 'search') {
      const status = params.status || 'active';
      const ids = await buscarTodosIds(accessToken, status);
      return { statusCode: 200, headers, body: JSON.stringify({ status, total: ids.length, ids }) };
    }

    if (params.action === 'bulk') {
      const ids = (params.ids || '').split(',').filter(Boolean);
      if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ids obrigatório' }) };
      const url = 'https://api.mercadolibre.com/items?ids=' + ids.join(',') + '&attributes=id,title,status,sub_status,variations';
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
      const data = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action obrigatório: search ou bulk' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
