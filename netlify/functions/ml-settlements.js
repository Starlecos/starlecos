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
    const token  = (event.headers.authorization || '').replace('Bearer ', '');
    const userId = event.queryStringParameters && event.queryStringParameters.user_id;
    const orderId = event.queryStringParameters && event.queryStringParameters.order_id;

    if (!token || !userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'token e user_id obrigatórios' }) };
    }

    // Buscar liquidações do pedido específico ou listar todas
    let url;
    if (orderId) {
      url = `https://api.mercadolibre.com/account/settlement_report/bulk/download?external_reference=${orderId}&user_id=${userId}`;
    } else {
      // Buscar movimentos financeiros (releases) do vendedor
      url = `https://api.mercadolibre.com/account/movements/search?user_id=${userId}&type=release&offset=0&limit=50`;
    }

    const res  = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
