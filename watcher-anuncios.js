// Watcher local — roda sempre no PC do Enzo, vigia a pasta raiz de fotos de
// anúncio novo. Quando acha Produto/Estampa/ com fotos + dados.txt completo
// e sem marcador ".enviado", sobe as fotos pro Storage do Supabase e insere
// uma linha em anuncios_fila (status "pendente_conteudo"). Daí em diante o
// jarvis (dentro de uma sessão do Claude Code) processa a fila pra gerar
// título/descrição — este script só faz a parte mecânica.
//
// Uso: node watcher-anuncios.js
// Pasta raiz configurável via variável de ambiente ANUNCIOS_PASTA_RAIZ,
// senão usa o padrão abaixo.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://pfaounkchpyfhlsdailo.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmYW91bmtjaHB5Zmhsc2RhaWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTYyOTEsImV4cCI6MjA5ODIzMjI5MX0.Xq9Q79fXxQpI52RbMMxM8AeCH__FNYxANt57a_ViQjA';
const BUCKET = 'anuncios-fotos';
const PASTA_RAIZ = process.env.ANUNCIOS_PASTA_RAIZ || 'C:\\Users\\pedro\\Fotos-Novos-Anuncios';
const INTERVALO_MS = 30000;
const EXTENSOES_FOTO = ['.jpg', '.jpeg', '.png', '.webp'];
const CAMPOS_OBRIGATORIOS = ['preco_classico', 'preco_premium', 'tecido', 'ziper', 'corte'];

const CONTENT_TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function log(msg) {
  console.log('[' + new Date().toLocaleString('pt-BR') + '] ' + msg);
}

function slugify(texto) {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseDados(texto) {
  const dados = {};
  texto.split(/\r?\n/).forEach(linha => {
    const idx = linha.indexOf(':');
    if (idx === -1) return;
    const chave = linha.slice(0, idx).trim().toLowerCase();
    const valor = linha.slice(idx + 1).trim();
    if (chave) dados[chave] = valor;
  });
  return dados;
}

function listarSubpastas(pasta) {
  return fs.readdirSync(pasta, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

async function subirFoto(caminhoLocal, produto, estampa, nomeArquivo) {
  const ext = path.extname(nomeArquivo).toLowerCase();
  const contentType = CONTENT_TYPE[ext] || 'application/octet-stream';
  const caminhoStorage = slugify(produto) + '/' + slugify(estampa) + '/' + Date.now() + '-' + slugify(path.basename(nomeArquivo, ext)) + ext;
  const buffer = fs.readFileSync(caminhoLocal);

  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + caminhoStorage, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': contentType },
    body: buffer
  });
  if (!res.ok) throw new Error('Falha ao subir foto ' + nomeArquivo + ': ' + res.status + ' ' + (await res.text()));
  return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + caminhoStorage;
}

async function inserirNaFila(produto, estampa, fotosUrls, dados) {
  const linha = {
    produto,
    estampa,
    fotos_urls: fotosUrls,
    preco_classico: parseFloat((dados.preco_classico || '').replace(',', '.')) || null,
    preco_premium: parseFloat((dados.preco_premium || '').replace(',', '.')) || null,
    atacado_texto: dados.atacado || null,
    tecido: dados.tecido || null,
    ziper: dados.ziper || null,
    corte: dados.corte || null,
    observacoes: dados.observacoes || null,
    sku_base: dados.sku_base || null,
    status: 'pendente_conteudo'
  };
  const res = await fetch(SUPABASE_URL + '/rest/v1/anuncios_fila', {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(linha)
  });
  if (!res.ok) throw new Error('Falha ao inserir em anuncios_fila: ' + res.status + ' ' + (await res.text()));
}

async function processarPasta(produto, estampa, pastaCompleta) {
  const marcador = path.join(pastaCompleta, '.enviado');
  if (fs.existsSync(marcador)) return;

  const dadosPath = path.join(pastaCompleta, 'dados.txt');
  if (!fs.existsSync(dadosPath)) return; // ainda não terminou de preparar a pasta

  const arquivos = fs.readdirSync(pastaCompleta);
  const fotos = arquivos.filter(f => EXTENSOES_FOTO.includes(path.extname(f).toLowerCase()));
  if (fotos.length === 0) return;

  const dados = parseDados(fs.readFileSync(dadosPath, 'utf8'));
  const faltando = CAMPOS_OBRIGATORIOS.filter(c => !dados[c]);
  if (faltando.length > 0) {
    log('⏳ ' + produto + '/' + estampa + ' — dados.txt incompleto, faltando: ' + faltando.join(', '));
    return;
  }

  log('📤 Processando ' + produto + '/' + estampa + ' (' + fotos.length + ' foto(s))...');
  const fotosUrls = [];
  for (const foto of fotos) {
    fotosUrls.push(await subirFoto(path.join(pastaCompleta, foto), produto, estampa, foto));
  }
  await inserirNaFila(produto, estampa, fotosUrls, dados);
  fs.writeFileSync(marcador, new Date().toISOString());
  log('✅ ' + produto + '/' + estampa + ' adicionado à fila (anuncios_fila).');
}

async function cicloVarredura() {
  if (!fs.existsSync(PASTA_RAIZ)) {
    log('⚠️ Pasta raiz não existe: ' + PASTA_RAIZ);
    return;
  }
  for (const produto of listarSubpastas(PASTA_RAIZ)) {
    const pastaProduto = path.join(PASTA_RAIZ, produto);
    for (const estampa of listarSubpastas(pastaProduto)) {
      const pastaCompleta = path.join(pastaProduto, estampa);
      try {
        await processarPasta(produto, estampa, pastaCompleta);
      } catch (e) {
        log('❌ Erro em ' + produto + '/' + estampa + ': ' + e.message);
      }
    }
  }
}

log('👀 Watcher de anúncios rodando. Pasta raiz: ' + PASTA_RAIZ);
cicloVarredura();
setInterval(cicloVarredura, INTERVALO_MS);
