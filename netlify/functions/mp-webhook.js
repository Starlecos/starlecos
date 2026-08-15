const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;

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

    const dataRaw   = pag.date_approved || pag.date_created;
    const data      = dataRaw
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dataRaw))
      : '';
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

    // Já entra como despesa no financeiro na hora, sem esperar classificação manual.
    // A categoria fica "A Classificar" até alguém refinar na aba MP Pagamentos.
    await fetch(SUPABASE_URL + '/rest/v1/contas_pagas', {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: Number(id), data, valor, descricao,
        categoria: 'A Classificar',
        pagamento: 'Mercado Pago',
        fornecedor: fornecedor || '—',
        comprovante: 'MP #' + id
      })
    });
  } catch(e) {
    console.error('Erro processar MP:', e);
  }
}
