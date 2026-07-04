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
    const token    = (event.headers.authorization || '').replace('Bearer ', '');
    const params   = event.queryStringParameters || {};
    const userId   = params.user_id;
    const offset   = params.offset || '0';
    const limit    = params.limit  || '50';
    const orderId  = params.order_id;

    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'token obrigatório' }) };

    let url;
    if (orderId) {
      // Buscar pedido específico
      url = `https://api.mercadolibre.com/orders/${orderId}`;
    } else {
      if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'user_id obrigatório' }) };
      url = `https://api.mercadolibre.com/orders/search?seller=${userId}&sort=date_desc&limit=${limit}&offset=${offset}`;
    }

    const res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
