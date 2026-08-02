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
    const params = event.queryStringParameters || {};
    const offset = params.offset     || '0';
    const limit  = params.limit      || '50';
    const begin  = params.begin_date || '';
    const end    = params.end_date   || '';

    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'token obrigatório' }) };

    // Buscar movimentações da conta MP (extrato)
    let url = `https://api.mercadopago.com/v1/account/movements/search?limit=${limit}&offset=${offset}`;
    if (begin) url += `&begin_date=${begin}`;
    if (end)   url += `&end_date=${end}`;

    const res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
