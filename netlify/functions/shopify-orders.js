// Custom apps criados pelo Dev Dashboard da Shopify (fluxo atual, 2026) não têm
// mais token estático "revelado uma vez" — o token é obtido via client_credentials
// grant (client_id + client_secret) e expira em ~24h. Pedimos um token novo a cada
// chamada desta function em vez de tentar cachear entre invocações serverless.
async function obterTokenShopify(store, clientId, clientSecret) {
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Falha ao obter token Shopify: ' + JSON.stringify(data));
  }
  return data.access_token;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const store        = process.env.SHOPIFY_STORE_DOMAIN;
    const clientId      = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret  = process.env.SHOPIFY_CLIENT_SECRET;
    if (!store || !clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify não configurado no servidor (faltam SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET nas variáveis de ambiente do Netlify)' }) };
    }

    const token = await obterTokenShopify(store, clientId, clientSecret);

    const params    = event.queryStringParameters || {};
    const limit     = params.limit || '50';
    const pageInfo  = params.page_info;

    let url = `https://${store}/admin/api/2024-01/orders.json?status=any&limit=${limit}`;
    if (pageInfo) url += `&page_info=${encodeURIComponent(pageInfo)}`;

    const res  = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify(data) };
    }

    // A API da Shopify pagina por cursor (header Link), não por offset como o ML.
    // Extraímos aqui o cursor da próxima página pra o cliente não precisar parsear
    // o header Link manualmente.
    const linkHeader = res.headers.get('link') || '';
    let nextPageInfo = null;
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (match) nextPageInfo = decodeURIComponent(match[1]);

    return { statusCode: 200, headers, body: JSON.stringify({ orders: data.orders || [], next_page_info: nextPageInfo }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
