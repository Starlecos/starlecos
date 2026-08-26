// Diagnóstico read-only: lista todos os produtos/variantes da Shopify e
// reporta quantos têm SKU preenchido vs. quantos faltam — usado pra saber
// o tamanho do trabalho de ajustar SKU antes de ligar a baixa automática
// de estoque (que depende de SKU pra casar a venda com o item certo).
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
    const store       = process.env.SHOPIFY_STORE_DOMAIN;
    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!store || !clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify não configurado no servidor' }) };
    }

    const token = await obterTokenShopify(store, clientId, clientSecret);

    let url = `https://${store}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`;
    const variantes = [];
    let paginas = 0;
    while (url && paginas < 30) {
      const res  = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      const data = await res.json();
      if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify(data) };

      (data.products || []).forEach(p => {
        (p.variants || []).forEach(v => {
          variantes.push({
            product_id: p.id, product_title: p.title,
            variant_id: v.id, variant_title: v.title,
            sku: v.sku || ''
          });
        });
      });

      const linkHeader = res.headers.get('link') || '';
      const match = linkHeader.match(/<([^>]*)>;\s*rel="next"/);
      url = match ? match[1] : null;
      paginas++;
    }

    const semSku = variantes.filter(v => !v.sku);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        total_variantes: variantes.length,
        com_sku: variantes.length - semSku.length,
        sem_sku: semSku.length,
        itens_sem_sku: semSku
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
