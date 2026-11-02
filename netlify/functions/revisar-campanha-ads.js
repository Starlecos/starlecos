// Revisão sob demanda de ROAS alvo/Orçamento de UMA campanha de Mercado Ads,
// disparada pelo botão "🔍 Revisar agora" no Financeiro (aba Mercado Ads).
// Pedido do Enzo em 01/11/2026: diferente da revisão de 7 dias (feita pelo
// agente starlecos-mercadoads via Claude Code, sob demanda dele avisando),
// esta roda sozinha no clique — chama a API da Anthropic direto, sem
// depender de uma sessão de Claude Code aberta.
//
// Compara a performance já sincronizada (mercadoads_campanhas, histórico
// por `periodo_de`/`periodo_ate`) entre a janela mais recente e a janela
// anterior à data que o Enzo escolher, contra o último valor aplicado em
// `ml_ads_acoes` (o "último dado que salvei"). Só grava ação `pendente`
// (precisa aplicar manualmente no painel do ML) quando a IA decide que
// precisa mudar algo — senão grava o ciclo direto como `aplicado`, sem
// exigir clique nenhum do Enzo, e a campanha cai em SEM_ALTERACAO_CICLO
// no Financeiro (mesma lógica de `statusCicloCampanha` já existente).
//
// Não chama a API do Mercado Ads de novo — usa só o que já foi
// sincronizado via "Buscar Performance". Se não tiver dado recente ou
// dado da janela anterior à data escolhida, avisa em vez de decidir com
// dado velho/incompleto (nunca inventa número).

const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FRAMEWORK = require('./_lib/framework-ads.json');

const SB_HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY
};

async function sbGetAll(table, params) {
  let linhas = [];
  let offset = 0;
  const LIMITE = 1000;
  while (true) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + params + '&limit=' + LIMITE + '&offset=' + offset, { headers: SB_HEADERS });
    if (!res.ok) throw new Error('Supabase ' + table + ': ' + res.status + ' ' + (await res.text()));
    const pagina = await res.json();
    linhas = linhas.concat(pagina);
    if (pagina.length < LIMITE) break;
    offset += LIMITE;
  }
  return linhas;
}

async function sbInsert(table, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Supabase insert ' + table + ': ' + res.status + ' ' + (await res.text()));
  return res.json();
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'use POST' }) };

  try {
    if (!SUPABASE_KEY) throw new Error('SUPABASE_ANON_KEY não configurada no Netlify');
    if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY não configurada no Netlify — configure em Site settings → Environment variables antes de usar este botão');

    const body = JSON.parse(event.body || '{}');
    const campanhaId = Number(body.campanha_id);
    const dataDesde = body.data_desde; // 'YYYY-MM-DD'
    if (!campanhaId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'campanha_id obrigatório' }) };
    if (!dataDesde || !/^\d{4}-\d{2}-\d{2}$/.test(dataDesde)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'data_desde obrigatória no formato YYYY-MM-DD' }) };

    // Já existe ação pendente pra essa campanha? Não roda outra análise em cima.
    const pendentesExistentes = await sbGetAll('ml_ads_acoes', 'select=id,tipo&campanha_id=eq.' + campanhaId + '&status=eq.pendente&tipo=in.(roas_alvo,orcamento)');
    if (pendentesExistentes.length) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Já existe ação pendente (' + pendentesExistentes.map(p => p.tipo).join(', ') + ') pra essa campanha — aplique ou resolva antes de rodar outra análise.' }) };
    }

    // Histórico de performance já sincronizado dessa campanha.
    const snapshots = await sbGetAll('mercadoads_campanhas', 'select=*&campanha_id=eq.' + campanhaId + '&order=sincronizado_em.desc');
    if (!snapshots.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Nenhum dado sincronizado pra essa campanha. Rode "Buscar Performance" no Financeiro primeiro.' }) };
    }

    const porPeriodo = {};
    snapshots.forEach(s => {
      const k = s.periodo_de + '_' + s.periodo_ate;
      if (!porPeriodo[k] || s.sincronizado_em > porPeriodo[k].sincronizado_em) porPeriodo[k] = s;
    });
    const periodos = Object.values(porPeriodo).sort((a, b) => new Date(b.periodo_ate) - new Date(a.periodo_ate));

    const janelaAtual = periodos[0];
    const diasDesdeSync = Math.floor((Date.now() - new Date(janelaAtual.sincronizado_em).getTime()) / 86400000);
    if (diasDesdeSync > 3) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Dado sincronizado mais recente tem ' + diasDesdeSync + ' dia(s) — rode "Buscar Performance" de novo antes de analisar com dado atualizado.' }) };
    }

    const janelaAnterior = periodos.find(p => new Date(p.periodo_ate) <= new Date(dataDesde + 'T00:00:00'));
    if (!janelaAnterior) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Não achei sincronização de performance anterior a ' + dataDesde + ' pra comparar. Sincronize um período que cubra antes dessa data primeiro.' }) };
    }

    // Último valor aplicado de cada tipo ("último dado que salvei").
    const aplicados = await sbGetAll('ml_ads_acoes', 'select=*&campanha_id=eq.' + campanhaId + '&status=eq.aplicado&tipo=in.(roas_alvo,orcamento)&order=aplicado_em.desc');
    const baseline = {
      roas_alvo: aplicados.find(a => a.tipo === 'roas_alvo') || null,
      orcamento: aplicados.find(a => a.tipo === 'orcamento') || null
    };

    const prompt = `Você é o especialista em Mercado Ads da Starlecos. Decida se a campanha abaixo precisa de ajuste de ROAS alvo e/ou Orçamento, comparando a janela de performance mais recente contra a anterior e contra o último valor aplicado. Use SEMPRE o valor exato da tabela de parâmetros pra qualquer novo valor recomendado — nunca calcule um número próprio.

CAMPANHA: ${janelaAtual.campanha_nome} (id ${campanhaId}), status ${janelaAtual.status}
Orçamento atual: R$${janelaAtual.budget}/dia | ROAS alvo atual: ${janelaAtual.roas_target}x | ACOS alvo atual: ${janelaAtual.acos_target}%

ÚLTIMO VALOR APLICADO (o que o Enzo salvou por último):
- ROAS alvo: ${baseline.roas_alvo ? baseline.roas_alvo.valor_novo + 'x (aplicado em ' + baseline.roas_alvo.aplicado_em + ')' : 'nenhum histórico ainda'}
- Orçamento: ${baseline.orcamento ? 'R$' + baseline.orcamento.valor_novo + '/dia (aplicado em ' + baseline.orcamento.aplicado_em + ')' : 'nenhum histórico ainda'}

JANELA ATUAL (${janelaAtual.periodo_de} a ${janelaAtual.periodo_ate}):
custo R$${janelaAtual.custo}, receita R$${janelaAtual.receita_total}, clicks ${janelaAtual.clicks}, unidades ${janelaAtual.unidades_total}, ACOS real ${janelaAtual.acos_real}%, ROAS real ${janelaAtual.roas_real}x

JANELA ANTERIOR (${janelaAnterior.periodo_de} a ${janelaAnterior.periodo_ate}):
custo R$${janelaAnterior.custo}, receita R$${janelaAnterior.receita_total}, clicks ${janelaAnterior.clicks}, unidades ${janelaAnterior.unidades_total}, ACOS real ${janelaAnterior.acos_real}%, ROAS real ${janelaAnterior.roas_real}x

FRAMEWORK OFICIAL DA STARLECOS (taxonomia, regra de desintoxicação e tabela de parâmetros): ${JSON.stringify(FRAMEWORK)}

Só recomende mudança se a tendência entre as janelas justificar de verdade (não decida por ruído/oscilação pequena). Responda só com a ferramenta decidir_ajuste_ads.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          name: 'decidir_ajuste_ads',
          description: 'Decide se a campanha precisa de ajuste de ROAS alvo e/ou orçamento',
          input_schema: {
            type: 'object',
            properties: {
              classificacao: { type: 'string', enum: ['ESCALAR', 'OTIMIZAR_LANCES', 'ROLLBACK', 'ALERTA_SEM_CONVERSAO', 'MANTER_OBSERVANDO'] },
              roas_alvo: {
                type: 'object',
                properties: {
                  precisa_mudar: { type: 'boolean' },
                  valor_novo: { type: 'number', description: 'Valor exato da tabela oficial. Obrigatório se precisa_mudar=true.' },
                  motivo: { type: 'string', description: 'Motivo específico citando os números reais das duas janelas.' }
                },
                required: ['precisa_mudar', 'motivo']
              },
              orcamento: {
                type: 'object',
                properties: {
                  precisa_mudar: { type: 'boolean' },
                  valor_novo: { type: 'number', description: 'Valor exato da tabela oficial. Obrigatório se precisa_mudar=true.' },
                  motivo: { type: 'string', description: 'Motivo específico citando os números reais das duas janelas.' }
                },
                required: ['precisa_mudar', 'motivo']
              }
            },
            required: ['classificacao', 'roas_alvo', 'orcamento']
          }
        }],
        tool_choice: { type: 'tool', name: 'decidir_ajuste_ads' }
      })
    });

    if (!anthropicRes.ok) {
      const errTxt = await anthropicRes.text();
      throw new Error('Anthropic API: ' + anthropicRes.status + ' ' + errTxt);
    }
    const anthropicData = await anthropicRes.json();
    const toolUse = (anthropicData.content || []).find(c => c.type === 'tool_use' && c.name === 'decidir_ajuste_ads');
    if (!toolUse) throw new Error('Resposta da IA sem decisão estruturada — tente de novo.');
    const decisao = toolUse.input;

    const agora = new Date().toISOString();
    const acoesGravadas = [];
    let algumaMudanca = false;

    for (const tipo of ['roas_alvo', 'orcamento']) {
      const d = decisao[tipo];
      if (!d) continue;
      const valorAtualBase = baseline[tipo] ? baseline[tipo].valor_novo : (tipo === 'roas_alvo' ? janelaAtual.roas_target : janelaAtual.budget);
      if (d.precisa_mudar) {
        algumaMudanca = true;
        const row = await sbInsert('ml_ads_acoes', {
          tipo, campanha_id: campanhaId, titulo: janelaAtual.campanha_nome,
          valor_atual: valorAtualBase, valor_novo: d.valor_novo,
          motivo: d.motivo, origem: 'revisao_manual_botao',
          criado_em: agora
        });
        acoesGravadas.push({ tipo, status: 'pendente', valor_novo: d.valor_novo, motivo: d.motivo, id: row[0] && row[0].id });
      } else {
        await sbInsert('ml_ads_acoes', {
          tipo, campanha_id: campanhaId, titulo: janelaAtual.campanha_nome,
          valor_atual: valorAtualBase, valor_novo: valorAtualBase,
          motivo: d.motivo, origem: 'revisao_manual_botao', status: 'aplicado',
          criado_em: agora, decidido_em: agora, aplicado_em: agora
        });
        acoesGravadas.push({ tipo, status: 'aplicado', valor_novo: valorAtualBase, motivo: d.motivo });
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        classificacao: decisao.classificacao,
        mudou: algumaMudanca,
        resumo: algumaMudanca
          ? 'Precisa de ajuste: ' + acoesGravadas.filter(a => a.status === 'pendente').map(a => a.tipo).join(' + ')
          : 'Sem alteração necessária — ciclo confirmado.',
        acoes: acoesGravadas
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
