// Webhook do Mercado Livre (tópico orders_v2) — baixa/devolve estoque em
// tempo real, mesmo com o Financeiro fechado. Função "background" (sufixo
// -background no nome): a Netlify já responde rápido pro ML sozinha e deixa
// essa função rodar até 15min em segundo plano — importante porque o ML
// exige resposta rápida do callback e nós ainda precisamos renovar token +
// buscar o pedido + buscar SKU de cada item, o que não cabe em <500ms.
//
// Token do ML é por sessão de vendedor (não por app, diferente da Shopify),
// então guardamos o refresh_token (rotativo — o ML troca ele a cada
// renovação) na tabela ml_auth_token do Supabase, protegida por RLS —
// só a service_role (nunca exposta ao navegador) consegue ler/escrever.

const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const ML_APP_ID = '6624742243995383'; // client_id público, PKCE (não é segredo — já hardcoded no financeiro.html)

function svcHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function obterTokenML() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1&select=refresh_token', { headers: svcHeaders() });
  const rows = await res.json();
  const refreshToken = rows[0] && rows[0].refresh_token;
  if (!refreshToken) throw new Error('Nenhum refresh_token salvo em ml_auth_token');

  const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: ML_APP_ID, refresh_token: refreshToken }).toString()
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('Falha ao renovar token ML: ' + JSON.stringify(tokenData));

  // ML rotaciona o refresh_token a cada uso — salva o novo já aqui, senão a
  // próxima renovação falha (o antigo já não vale mais).
  await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1', {
    method: 'PATCH', headers: svcHeaders(),
    body: JSON.stringify({ refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, atualizado_em: new Date().toISOString() })
  });

  return tokenData.access_token;
}

async function buscarSkuItem(accessToken, itemId, variationId) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (variationId) {
    const res = await fetch('https://api.mercadolibre.com/items/' + itemId + '/variations/' + variationId, { headers });
    const data = await res.json();
    const attr = (data.attributes || []).find(a => a.id === 'SELLER_SKU');
    return attr ? attr.value_name : null;
  }
  const res = await fetch('https://api.mercadolibre.com/items/' + itemId, { headers });
  const data = await res.json();
  return data.seller_custom_field || null;
}

async function aplicarMovimento(canal, pedidoId, sku, delta, motivo) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/aplicar_movimento_estoque', {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_canal: canal, p_pedido_id: pedidoId, p_sku: sku, p_delta: delta, p_motivo: motivo })
  });
  if (!res.ok) console.error('Erro ao aplicar movimento de estoque (' + sku + '):', await res.text());
}

exports.handler = async function(event) {
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.topic !== 'orders_v2' || !body.resource) {
      return { statusCode: 200, body: 'ignorado' };
    }

    const accessToken = await obterTokenML();

    const orderRes = await fetch('https://api.mercadolibre.com' + body.resource, { headers: { Authorization: 'Bearer ' + accessToken } });
    const order = await orderRes.json();
    if (!orderRes.ok) { console.error('Erro ao buscar pedido:', order); return { statusCode: 200, body: 'erro ao buscar pedido' }; }

    const status = order.status; // 'paid', 'cancelled', etc.
    let motivo, sinal;
    if (status === 'paid') { motivo = 'venda'; sinal = -1; }
    else if (status === 'cancelled') { motivo = 'cancelamento'; sinal = 1; }
    else { return { statusCode: 200, body: 'status ' + status + ' ignorado (não é venda confirmada nem cancelamento)' }; }

    const itens = order.order_items || [];
    for (const oi of itens) {
      const itemId = oi.item.id;
      const variationId = oi.item.variation_id || null;
      const sku = await buscarSkuItem(accessToken, itemId, variationId);
      if (!sku) { console.warn('Item sem SKU, ignorando:', itemId, variationId); continue; }
      await aplicarMovimento('mercado_livre', String(order.id), sku, sinal * (oi.quantity || 1), motivo);
    }

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'erro: ' + e.message };
  }
};
