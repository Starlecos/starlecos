const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const MP_TOKEN   = 'APP_USR-6598280361009358-080218-6705ff815040a88da4fa89210ccbb8c1-1781620508';

exports.handler = async function(event) {
  // Retornar 200 imediatamente para qualquer requisição
  // O MP exige resposta rápida e simples
  const params = event.queryStringParameters || {};
  const tipo   = params.topic || params.type || '';
  const id     = params.id || '';

  // Processar em background sem aguardar
  if (id && (tipo === 'payment' || tipo === 'money_transfer')) {
    processarAsync(tipo, id);
  }

  // Resposta imediata 200
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'OK'
  };
};

async function processarAsync(tipo, id) {
  try {
    const SB_HEADERS = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    };

    const res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN }
    });
    const pag = await res.json();

    if (!pag.id || pag.status !== 'approved') return;

    const USER_ID = '1781620508';
    if (!pag.payer || String(pag.payer.id) !== USER_ID) return;

    const data      = (pag.date_approved || pag.date_created || '').split('T')[0];
    const valor     = Math.abs(pag.transaction_amount || 0);
    const descricao = pag.description || 'Pagamento MP #' + id;
    const fornecedor = (pag.collector && pag.collector.email) ? pag.collector.email : '—';

    await fetch(SUPABASE_URL + '/rest/v1/mp_pagamentos_pendentes', {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: String(id), data, valor, descricao, fornecedor,
        tipo: pag.operation_type || tipo,
        status: pag.status,
        classificado: false,
        raw: JSON.stringify(pag)
      })
    });
  } catch(e) {
    console.error('Erro processar MP:', e);
  }
}
