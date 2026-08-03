const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const MP_TOKEN   = 'APP_USR-6598280361009358-080218-6705ff815040a88da4fa89210ccbb8c1-1781620508';
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
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
  }

  // IPN usa GET com query params: ?topic=payment&id=123
  // Webhook usa POST com body JSON
  let tipo = '';
  let id   = '';

  if (event.httpMethod === 'GET') {
    // IPN validation - MP exige 200 simples
    const params = event.queryStringParameters || {};
    tipo = params.topic || params.type || '';
    id   = params.id || '';
    console.log('IPN GET:', tipo, id);
    // Processar em background e retornar 200 imediatamente
    if (tipo && id) {
      // Processar de forma assíncrona (não aguardar)
      processarPagamentoMP(tipo, id).catch(e => console.error(e));
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' };
  } else if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      tipo = body.type || body.topic || '';
      id   = body.data && body.data.id ? body.data.id : (body.id || '');
      console.log('Webhook POST:', tipo, id);
    } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
    }
  }

  if (!id) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
  }

  const resultado = await processarPagamentoMP(tipo, id);
  return { statusCode: 200, headers, body: JSON.stringify(resultado) };
};

async function processarPagamentoMP(tipo, id) {
  try {
    // Buscar detalhes do pagamento
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN }
    });
    const pag = await res.json();

    console.log('Pagamento:', JSON.stringify({
      id: pag.id,
      status: pag.status,
      operation_type: pag.operation_type,
      amount: pag.transaction_amount,
      payer_id: pag.payer && pag.payer.id,
      collector_id: pag.collector && pag.collector.id
    }));

    if (!pag.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_found', pag_status: res.status }) };
    }

    // Aceitar apenas aprovados
    if (pag.status !== 'approved') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_approved', pag_status: pag.status }) };
    }

    // Verificar se é saída — payer é a conta Starlecos
    const USER_ID = '1781620508';
    const ehSaida = pag.payer && String(pag.payer.id) === USER_ID;

    if (!ehSaida) {
      return { statusCode: 200, headers, body: JSON.stringify({ 
        status: 'not_outgoing',
        payer_id: pag.payer && pag.payer.id,
        collector_id: pag.collector && pag.collector.id
      })};
    }

    const data      = (pag.date_approved || pag.date_created || '').split('T')[0];
    const valor     = Math.abs(pag.transaction_amount || 0);
    const descricao = pag.description || 'Pagamento MP #' + id;
    const fornecedor = (pag.collector && pag.collector.email) ? pag.collector.email : '—';

    await fetch(SUPABASE_URL + '/rest/v1/mp_pagamentos_pendentes', {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: String(id),
        data, valor, descricao, fornecedor,
        tipo: pag.operation_type || tipo,
        status: pag.status,
        classificado: false,
        raw: JSON.stringify(pag)
      })
    });

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', id, valor, data }) };
  } catch(e) {
    console.error('Webhook erro:', e);
    return { status: 'error', error: e.message };
  }
}
