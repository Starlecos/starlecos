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
    const token   = (event.headers.authorization || '').replace('Bearer ', '');
    const userId  = event.queryStringParameters && event.queryStringParameters.user_id;
    const orderId = event.queryStringParameters && event.queryStringParameters.order_id;

    if (!token || !userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'token e user_id obrigatórios' }) };
    }

    // Tentar diferentes endpoints de liquidação
    const endpoints = [
      `https://api.mercadolibre.com/users/${userId}/mercadopago_account/movements?type=release&limit=50`,
      `https://api.mercadolibre.com/collections/search?seller_id=${userId}&status=approved&sort=date_created.desc&limit=1`,
      `https://api.mercadolibre.com/orders/${orderId}/payments`
    ];

    const url = orderId
      ? `https://api.mercadolibre.com/orders/${orderId}/payments`
      : `https://api.mercadolibre.com/users/${userId}/mercadopago_account/movements?type=release&limit=10`;

    const res  = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
