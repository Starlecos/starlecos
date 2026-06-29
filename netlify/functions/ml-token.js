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
    const body = JSON.parse(event.body || '{}');
    const { grant_type, code, refresh_token } = body;

    const params = new URLSearchParams({
      grant_type,
      client_id:     '6624742243995383',
      client_secret: 'KxM33KRxAQf6Y82GaWi9paRiiKv7KawK',
      redirect_uri:  'https://ubiquitous-youtiao-3a8ab4.netlify.app/starlecos-financeiro.html'
    });

    if (grant_type === 'authorization_code') params.set('code', code);
    if (grant_type === 'refresh_token')      params.set('refresh_token', refresh_token);

    const res  = await fetch('https://api.mercadolibre.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    params.toString()
    });

    const data = await res.json();
    return { statusCode: res.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
