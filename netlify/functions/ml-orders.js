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
    const offset = event.queryStringParameters && event.queryStringParameters.offset || '0';
    const limit  = event.queryStringParameters && event.queryStringParameters.limit  || '50';

    if (!token || !userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'token e user_id obrigatórios' }) };
    }

    const url = `https://api.mercadolibre.com/orders/search?seller=${userId}&sort=date_desc&limit=${limit}&offset=${offset}`;
    const res  = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
