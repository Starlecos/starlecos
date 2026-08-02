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
    
    // O MP envia notificações com tipo e id
    const tipo = body.type || body.topic || '';
    const id   = body.data && body.data.id ? body.data.id : (body.id || '');

    if (!id || !tipo) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ignored' }) };
    }

    // Só processar pagamentos (não recebimentos de vendas ML)
    if (tipo !== 'payment') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ignored', tipo }) };
    }

    // Buscar detalhes do pagamento
    const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
    if (!ACCESS_TOKEN) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'no_token' }) };
    }

    const res  = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN }
    });
    const pagamento = await res.json();

    // Filtrar somente saídas (dinheiro enviado)
    // operation_type: money_transfer = PIX/transferência enviada
    if (pagamento.operation_type !== 'money_transfer' && pagamento.payer && pagamento.payer.id === pagamento.collector && pagamento.collector.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_outgoing' }) };
    }

    // Salvar no Supabase como conta pendente de classificação
    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pfaounkchpyfhlsdailo.supabase.co';
    const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';

    const data = (pagamento.date_approved || pagamento.date_created || '').split('T')[0];
    const valor = Math.abs(pagamento.transaction_amount || 0);
    const descricao = pagamento.description || 'Pagamento MP #' + id;
    const fornecedor = pagamento.collector && pagamento.collector.email ? pagamento.collector.email : '—';

    await fetch(SUPABASE_URL + '/rest/v1/mp_pagamentos_pendentes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        id: String(id),
        data,
        valor,
        descricao,
        fornecedor,
        tipo: pagamento.operation_type || tipo,
        status: pagamento.status,
        classificado: false,
        raw: JSON.stringify(pagamento)
      })
    });

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', id }) };
  } catch(e) {
    console.error('Webhook MP erro:', e);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
