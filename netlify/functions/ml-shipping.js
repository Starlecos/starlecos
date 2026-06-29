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
    const token      = (event.headers.authorization || '').replace('Bearer ', '');
    const shippingId = event.queryStringParameters && event.queryStringParameters.shipping_id;

    if (!token || !shippingId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'token e shipping_id obrigatórios' }) };
    }

    const res  = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
