// Conferência de estoque: compara a quantidade INTERNA (estoque_produtos,
// fonte da verdade) com o que o Mercado Livre realmente tem em cada anúncio
// mapeado em sku_ml_listagens. SÓ LEITURA — nunca escreve no ML. Quem
// corrige é o cliente, chamando push-estoque por SKU divergente (que já
// escreve E confere de volta o valor real).
//
// Existe porque o push de estoque é "dispare e esqueça": se o ML recusar
// (429, anúncio em hold etc.), ninguém ficava sabendo e o anúncio ficava
// com estoque errado até alguém reparar (caso Jaleco Masculino Safari,
// 26/09/2026: ML mostrava 13 un., interno tinha 29).
//
// Paginado (offset/limit sobre sku_ml_listagens) pra caber no tempo de uma
// function — o cliente chama em loop até acabar.
const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ML_APP_ID = '6624742243995383';

function svcHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function obterTokenML() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1&select=refresh_token,access_token,atualizado_em', { headers: svcHeaders() });
  const rows = await res.json();
  const row = rows[0];
  if (!row || !row.refresh_token) throw new Error('Nenhum refresh_token salvo em ml_auth_token');

  // reusa o access_token guardado se ainda válido (renovar em toda chamada
  // já causou rate-limit no ML — ver push-estoque.js)
  if (row.access_token && row.atualizado_em) {
    const idadeMs = Date.now() - new Date(row.atualizado_em).getTime();
    if (idadeMs < 5 * 60 * 60 * 1000) return row.access_token;
  }

  const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, refresh_token: row.refresh_token
    }).toString()
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('Falha ao renovar token ML: ' + JSON.stringify(tokenData));

  await fetch(SUPABASE_URL + '/rest/v1/ml_auth_token?id=eq.1', {
    method: 'PATCH', headers: svcHeaders(),
    body: JSON.stringify({ refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, atualizado_em: new Date().toISOString() })
  });
  return tokenData.access_token;
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const params = event.queryStringParameters || {};
    const offset = parseInt(params.offset) || 0;
    const limit = Math.min(parseInt(params.limit) || 100, 200);

    // 1) Fatia de anúncios mapeados (ordem estável por id)
    const listRes = await fetch(
      SUPABASE_URL + '/rest/v1/sku_ml_listagens?select=sku,ml_item_id,ml_variation_id&order=id.asc&limit=' + limit + '&offset=' + offset,
      { headers: svcHeaders() }
    );
    const listagens = await listRes.json();
    if (!Array.isArray(listagens)) throw new Error('Erro lendo sku_ml_listagens: ' + JSON.stringify(listagens));
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

    // 3) Estado real no ML, em lotes de até 20 anúncios (multiget)
    const accessToken = await obterTokenML();
    const ids = [...new Set(listagens.map(l => l.ml_item_id))];
    const mlPorItem = {};
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const res = await fetch(
        'https://api.mercadolibre.com/items?ids=' + lote.join(',') + '&attributes=id,title,available_quantity,status,variations',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('Multiget ML falhou (' + res.status + '): ' + JSON.stringify(arr).slice(0, 300));
      arr.forEach(x => { if (x.code === 200 && x.body) mlPorItem[x.body.id] = x.body; });
    }

    // 4) Compara
    const divergentes = [];
    let semLeitura = 0;
    listagens.forEach(l => {
      if (!(l.sku in interno)) return; // SKU sem linha no estoque interno — outro problema, não é divergência de quantidade
      const item = mlPorItem[l.ml_item_id];
      if (!item) { semLeitura++; return; }
      let mlQtd = item.available_quantity;
      if (l.ml_variation_id) {
        const v = (item.variations || []).find(v => v.id === l.ml_variation_id);
        if (!v) { semLeitura++; return; }
        mlQtd = v.available_quantity;
      }
      if (mlQtd !== interno[l.sku]) {
        divergentes.push({
          sku: l.sku, ml_item_id: l.ml_item_id, ml_variation_id: l.ml_variation_id,
          titulo: item.title || null,
          interno: interno[l.sku], ml: mlQtd, status_ml: item.status
        });
      }
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ offset, total_lidos: listagens.length, fim: listagens.length < limit, sem_leitura: semLeitura, divergentes })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
