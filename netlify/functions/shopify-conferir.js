// Conferência de estoque: compara a quantidade INTERNA (estoque_produtos,
// fonte da verdade) com o que a Shopify realmente tem em cada variante
// mapeada em sku_canal_map (shopify_variant_id). SÓ LEITURA — nunca escreve
// na Shopify. Mesmo padrão de estoque-conferir.js (ML), criado em 07/10/2026
// na mesma auditoria que achou o caso Jaleco Capivara.
//
// Shopify não tem um multiget de variantes como o ML — lê uma por uma
// (GET /variants/{id}.json, que já traz inventory_quantity agregado).
// Página pequena (20) de propósito pra não estourar o tempo da function
// respeitando o rate limit da Shopify (~2 req/s) — o cliente chama em loop.
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';

function svcHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function obterTokenShopify(store, clientId, clientSecret) {
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString()
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Falha ao obter token Shopify: ' + JSON.stringify(data));
  return data.access_token;
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const params = event.queryStringParameters || {};
    const offset = parseInt(params.offset) || 0;
    const limit = Math.min(parseInt(params.limit) || 12, 15); // pequeno de propósito: ~550ms de espera por item pra respeitar o rate limit

    // 1) Fatia de variantes mapeadas (ordem estável por sku)
    const listRes = await fetch(
      SUPABASE_URL + '/rest/v1/sku_canal_map?select=sku,shopify_variant_id&shopify_variant_id=not.is.null&order=sku.asc&limit=' + limit + '&offset=' + offset,
      { headers: svcHeaders() }
    );
    const listagens = await listRes.json();
    if (!Array.isArray(listagens)) throw new Error('Erro lendo sku_canal_map: ' + JSON.stringify(listagens));
    if (!listagens.length) return { statusCode: 200, headers, body: JSON.stringify({ offset, total_lidos: 0, fim: true, divergentes: [] }) };

    // 2) Quantidade interna desses SKUs
    const skus = [...new Set(listagens.map(l => l.sku))];
    const estRes = await fetch(
      SUPABASE_URL + '/rest/v1/estoque_produtos?select=sku,quantidade&sku=in.(' + skus.map(s => '"' + s + '"').join(',') + ')',
      { headers: svcHeaders() }
    );
    const estRows = await estRes.json();
    if (!Array.isArray(estRows)) throw new Error('Erro lendo estoque_produtos: ' + JSON.stringify(estRows));
    const interno = {};
    estRows.forEach(e => { interno[e.sku] = e.quantidade || 0; });

    // 3) Estado real na Shopify, uma variante por vez
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!store || !clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify não configurado no servidor (faltam variáveis de ambiente)' }) };
    }
    const token = await obterTokenShopify(store, clientId, clientSecret);

    const divergentes = [];
    let semLeitura = 0;
    for (const l of listagens) {
      if (!(l.sku in interno)) continue; // SKU sem linha no estoque interno — outro problema
      try {
        // Rate limit da Shopify (~2 req/s, bucket de 40) — sem espaçar, boa
        // parte das leituras volta 429 e vira falso "sem_leitura" (achado
        // real em 07/10/2026: 95 de 244 sem ler na primeira tentativa sem
        // esse delay). 1 retry com espera maior se vier 429.
        let res = await fetch(`https://${store}/admin/api/2024-01/variants/${l.shopify_variant_id}.json`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 1500));
          res = await fetch(`https://${store}/admin/api/2024-01/variants/${l.shopify_variant_id}.json`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
        }
        if (!res.ok) { semLeitura++; await new Promise(r => setTimeout(r, 550)); continue; }
        const data = await res.json();
        const v = data.variant;
        if (!v) { semLeitura++; await new Promise(r => setTimeout(r, 550)); continue; }
        const shopQtd = v.inventory_quantity;
        // Interno pode ficar negativo de propósito (pedido de Turma —
        // reserva contra produção futura). Shopify nunca mostra negativo
        // (push-estoque manda 0 nesse caso) — compara contra o
        // "disponível" (0 se negativo), senão toda reserva de Turma
        // aparece como falsa divergência aqui.
        const internoDisponivel = Math.max(0, interno[l.sku]);
        if (shopQtd !== internoDisponivel) {
          divergentes.push({
            sku: l.sku, shopify_variant_id: l.shopify_variant_id,
            titulo: v.title || null,
            interno: interno[l.sku], shopify: shopQtd
          });
        }
        await new Promise(r => setTimeout(r, 550)); // ~1,8 req/s, dentro do limite
      } catch (e) { semLeitura++; }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ offset, total_lidos: listagens.length, fim: listagens.length < limit, sem_leitura: semLeitura, divergentes })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
