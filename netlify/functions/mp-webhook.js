const MP_SECRET = 'fad2c21efb2e7a3f84f2ae5c15b7dbded32b6829f5a16b6bbebec2bc75e71536';
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const MP_TOKEN   = 'APP_USR-2652530613418056-080218-f84b80c853e3c6b60ba96c0c8ee081e7-3583652481';
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-signature, x-request-id',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Aceitar GET para validação inicial do MP
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const tipo = body.type || body.topic || '';
    const id   = body.data && body.data.id ? body.data.id : (body.id || '');

    console.log('Webhook MP recebido:', tipo, id);

    // Só processar eventos de pagamento
    if (tipo !== 'payment' || !id) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ignored' }) };
    }

    // Buscar detalhes do pagamento
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN }
    });
    const pag = await res.json();

    console.log('Pagamento:', pag.id, pag.operation_type, pag.status, pag.transaction_amount);

    // Filtrar somente saídas (money_transfer = PIX/transferência enviada)
    if (pag.operation_type !== 'money_transfer') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_outgoing', op: pag.operation_type }) };
    }

    // Só saídas aprovadas
    if (pag.status !== 'approved') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_approved' }) };
    }

    const data      = (pag.date_approved || pag.date_created || '').split('T')[0];
    const valor     = Math.abs(pag.transaction_amount || 0);
    const descricao = pag.description || 'Pagamento MP #' + id;
    const fornecedor = (pag.collector && pag.collector.email) ? pag.collector.email : '—';

    // Salvar no Supabase como pendente de classificação
    const sbRes = await fetch(SUPABASE_URL + '/rest/v1/mp_pagamentos_pendentes', {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: String(id),
        data,
        valor,
        descricao,
        fornecedor,
        tipo: pag.operation_type,
        status: pag.status,
        classificado: false,
        raw: JSON.stringify(pag)
      })
    });

    console.log('Supabase status:', sbRes.status);

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', id, valor, data }) };
  } catch(e) {
    console.error('Webhook MP erro:', e);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
