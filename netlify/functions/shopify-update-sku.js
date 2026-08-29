// Aplica o SKU corrigido em variantes reais da Shopify.
// Recebe { updates: [{ variant_id, sku }, ...] } via POST e escreve um por
// um via PUT /variants/{id}.json (API padrão de produto, não a de estoque —
// write_products precisa estar no escopo do app). Retorna sucesso/erro por item.
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'use POST' }) };

  try {
    const store       = process.env.SHOPIFY_STORE_DOMAIN;
    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!store || !clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify não configurado no servidor' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const updates = body.updates || [];
    if (!updates.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'updates vazio' }) };

    const token = await obterTokenShopify(store, clientId, clientSecret);
    const resultados = [];

    for (const u of updates) {
      try {
        const res = await fetch(`https://${store}/admin/api/2024-01/variants/${u.variant_id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: { id: u.variant_id, sku: u.sku } })
        });
        const data = await res.json();
        resultados.push({ variant_id: u.variant_id, sku: u.sku, ok: res.ok, status: res.status, error: res.ok ? null : data });
      } catch (e) {
        resultados.push({ variant_id: u.variant_id, sku: u.sku, ok: false, error: e.message });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ resultados }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
