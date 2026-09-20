// Busca pedidos do vendedor no ML com o token guardado no servidor (só leitura).
// Usado pra conferir/corrigir pedidos antigos sem depender do token do navegador.
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ML_APP_ID = '6624742243995383';

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

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const p = event.queryStringParameters || {};
    const offset = p.offset || '0';
    const accessToken = await obterTokenML();
    const url = 'https://api.mercadolibre.com/orders/search?seller=1781620508&sort=date_desc&limit=50&offset=' + offset;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
