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
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const tipo = body.type || body.topic || '';
    const id   = body.data && body.data.id ? body.data.id : (body.id || '');

    console.log('Webhook MP:', JSON.stringify(body));

    if (tipo !== 'payment' || !id) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ignored', tipo, id }) };
    }

    // Tentar buscar como payment primeiro, depois como transferência
    let res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN }
    });
    let pag = await res.json();

    // Se não encontrou como payment, tentar como money_transfer
    if (res.status === 404 || pag.status === 404) {
      res = await fetch(`https://api.mercadopago.com/v1/account/movements/${id}`, {
        headers: { 'Authorization': 'Bearer ' + MP_TOKEN }
      });
      if (res.ok) {
        pag = await res.json();
        pag.operation_type = pag.operation_type || 'money_transfer';
        pag.status = pag.status || 'approved';
        pag.transaction_amount = pag.amount || pag.transaction_amount;
        pag.payer = pag.payer || { id: '1781620508' };
      }
    }

    console.log('Pagamento detalhes:', JSON.stringify({
      id: pag.id,
      operation_type: pag.operation_type,
      status: pag.status,
      transaction_amount: pag.transaction_amount,
      payer_id: pag.payer && pag.payer.id,
      collector_id: pag.collector && pag.collector.id
    }));

    // Log completo para debug
    console.log('Status:', pag.status, 'Op type:', pag.operation_type, 'Payer:', pag.payer && pag.payer.id);

    // Aceitar pagamentos aprovados OU processados
    const statusOk = ['approved', 'processed', 'settled'].includes(pag.status);
    if (!statusOk) {
      return { statusCode: 200, headers, body: JSON.stringify({ 
        status: 'not_approved', 
        pag_status: pag.status,
        operation_type: pag.operation_type,
        payer_id: pag.payer && pag.payer.id
      }) };
    }

    // Filtrar saídas: o pagador é o dono da conta
    const USER_ID = '3583652481';
    const ehSaida = pag.payer && String(pag.payer.id) === USER_ID;

    if (!ehSaida) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_outgoing', payer_id: pag.payer && pag.payer.id }) };
    }

    const data      = (pag.date_approved || pag.date_created || '').split('T')[0];
    const valor     = Math.abs(pag.transaction_amount || 0);
    const descricao = pag.description || 'Pagamento MP #' + id;
    const fornecedor = (pag.collector && pag.collector.email) ? pag.collector.email : '—';

    const sbRes = await fetch(SUPABASE_URL + '/rest/v1/mp_pagamentos_pendentes', {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: String(id),
        data,
        valor,
        descricao,
        fornecedor,
        tipo: pag.operation_type || tipo,
        status: pag.status,
        classificado: false,
        raw: JSON.stringify(pag)
      })
    });

    console.log('Supabase:', sbRes.status);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', id, valor, data, ehSaida }) };
  } catch(e) {
    console.error('Webhook erro:', e);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
