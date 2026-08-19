// Proxy genérico pra API de Mercado Ads (Product Ads) do Mercado Livre.
// Genérico de propósito: a documentação oficial bloqueia acesso automatizado
// (403) e o contrato exato mudou recentemente (endpoints legacy desativados
// em 2026, ACOS objetivo virou ROAS objetivo) — em vez de arriscar hardcode
// de um caminho que pode já estar errado, o cliente informa o path exato e
// a function só repassa com o Bearer token, igual o ml-orders.js já faz pra
// pedidos. Path e querystring exatos a usar serão confirmados testando ao
// vivo contra a API assim que a permissão de Publicidade estiver ativa.
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'token obrigatório' }) };

    const params = event.queryStringParameters || {};
    const path   = params.path;
    if (!path) return { statusCode: 400, headers, body: JSON.stringify({ error: 'path obrigatório (ex: path=/advertising/advertisers)' }) };

    // Repassa qualquer outro query param recebido (date_from, date_to, metrics, limit, offset etc.)
    const extra = new URLSearchParams(params);
    extra.delete('path');
    const qs = extra.toString();

    const url = 'https://api.mercadolibre.com' + path + (qs ? '?' + qs : '');
    const res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Api-Version': params.api_version || '2' } });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
