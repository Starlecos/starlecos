// Webhook da Shopify — orders/paid e orders/cancelled.
// Descontar/devolver estoque em tempo real (sem precisar abrir o Financeiro).
// A Shopify chama isso sozinha a cada pedido pago/cancelado.
const crypto = require('crypto');

const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';

function verificarHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader) return false;
  const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
  } catch (e) {
    return false; // tamanhos diferentes = assinatura não bate
  }
}

async function aplicarMovimento(canal, pedidoId, sku, delta, motivo) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/aplicar_movimento_estoque', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_canal: canal, p_pedido_id: pedidoId, p_sku: sku, p_delta: delta, p_motivo: motivo })
  });
  if (!res.ok) {
    console.error('Erro ao aplicar movimento de estoque (' + sku + '):', await res.text());
  }
  return res.ok;
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

exports.handler = async function(event) {
  try {
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!secret) return { statusCode: 500, body: 'SHOPIFY_CLIENT_SECRET não configurado' };

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');

    const hmacHeader = getHeader(event.headers, 'x-shopify-hmac-sha256');
    if (!verificarHmac(rawBody, hmacHeader, secret)) {
      return { statusCode: 401, body: 'assinatura inválida' };
    }

    const topic = getHeader(event.headers, 'x-shopify-topic');
    let motivo, sinal;
    if (topic === 'orders/paid') { motivo = 'venda'; sinal = -1; }
    else if (topic === 'orders/cancelled') { motivo = 'cancelamento'; sinal = 1; }
    else return { statusCode: 200, body: 'tópico ignorado: ' + topic };

    const order = JSON.parse(rawBody);
    const itens = order.line_items || [];

    for (const item of itens) {
      if (!item.sku) continue; // sem SKU não tem como casar com o estoque interno
      await aplicarMovimento('shopify', String(order.id), item.sku, sinal * (item.quantity || 1), motivo);
    }

    // Fase seguinte: empurrar a quantidade atualizada pro Mercado Livre
    // (a Shopify já ajusta a própria contagem sozinha quando o pedido é
    // pago/cancelado, não precisamos empurrar de volta pra ela mesma).

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'erro: ' + e.message };
  }
};
