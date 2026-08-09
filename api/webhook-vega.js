// api/webhook-vega.js
// Recebe as notificações de venda do checkout (Vega) e fecha o funil.
//
// Sem isto o painel enxerga até "foi pro checkout" e para: a venda acontece
// num domínio que não é nosso. Com isto, cada pedido vira uma linha em
// bt_orders e — quando dá pra identificar a visita — carimba a compra na
// própria sessão, o que permite cruzar venda com nota do quiz, faixa e origem.
//
// ── URL pra colar no painel do gateway ──────────────────────────────────────
//   https://SEU-DOMINIO/api/webhook-vega?token=VALOR_DE_VEGA_WEBHOOK_TOKEN
//
// O token pode chegar de quatro jeitos (o gateway escolhe): query `?token=`,
// header `x-vega-token`/`x-webhook-token`, `Authorization: Bearer` ou dentro do
// próprio corpo (`token`, `eventType.token`). Todos são aceitos.
//
// ── Por que o parser é tolerante ────────────────────────────────────────────
// O formato exato do payload varia por gateway e por versão. Em vez de casar
// com um contrato rígido — que quebra calado no dia em que o campo muda de
// nome —, este handler VARRE o JSON inteiro procurando os campos que importam
// por vários nomes conhecidos, e guarda o payload cru em `raw` de qualquer
// jeito. Se um campo não for reconhecido, a venda entra mesmo assim e o painel
// mostra o cru pra você conferir. Nunca se perde um pedido por causa de
// nomenclatura.

const crypto = require('crypto');
const db = require('./_db');

const MAX_RAW = 60000;   // o que passa disso vira resumo — JSONB não é depósito

// ── Autenticação ────────────────────────────────────────────────────────────
function tokenEsperado() {
  return process.env.VEGA_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || '';
}

function igual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function tokenRecebido(req, body) {
  const q = req.query || {};
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  return (
    q.token || q.secret || q.key ||
    h['x-vega-token'] || h['x-webhook-token'] || h['x-hub-signature'] ||
    (auth.startsWith('Bearer ') ? auth.slice(7) : '') ||
    (body && (body.token || (body.eventType && body.eventType.token))) ||
    ''
  );
}

// ── Varredura do payload ────────────────────────────────────────────────────
// Achata o JSON em trios [chave-normalizada, valor, caminho] e guarda todas as
// strings à parte (é nelas que o id da sessão pode estar escondido em campo
// livre). O caminho — 'order.customer.email' — é o que permite desempatar
// chaves genéricas como `id`, que aparecem em meia dúzia de lugares.
function varrer(valor, chave, ctx, prof, caminho) {
  if (valor == null || prof > 8 || ctx.campos.length > 600) return;
  const norm = String(chave || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cam = norm ? (caminho ? caminho + '.' + norm : norm) : caminho;

  if (Array.isArray(valor)) {
    valor.forEach((v) => varrer(v, chave, ctx, prof + 1, caminho));
    return;
  }
  if (typeof valor === 'object') {
    Object.keys(valor).forEach((k) => varrer(valor[k], k, ctx, prof + 1, cam));
    return;
  }
  ctx.campos.push([norm, valor, cam || norm]);
  if (typeof valor === 'string') ctx.textos.push(valor);
}

/** Primeiro valor não-vazio cujo nome de campo bate. A ORDEM da lista é a
 *  prioridade: 'totalvalue' antes de 'amount' evita pegar o valor de um item
 *  quando existe o total do pedido. Devolve [chave, valor] ou [null, null]. */
function acha(ctx, nomes) {
  for (const nome of nomes) {
    for (const [k, v] of ctx.campos) {
      if (k === nome && v !== '' && v !== null && v !== undefined) return [k, v];
    }
  }
  return [null, null];
}

/**
 * Id do pedido — o campo mais perigoso do payload inteiro.
 *
 * Ele é a chave de idempotência: errar aqui não é perder um dado, é fazer
 * pedidos diferentes colidirem na mesma linha. O caso concreto que motivou
 * esta função: um payload com `eventType.code = 'ORDER_PAID'` e o id de
 * verdade em `order.id` — pegar `code` faria TODAS as vendas aprovadas virarem
 * uma só.
 *
 * Daí as três passadas, da mais específica pra menos:
 *   1. nomes que só podem ser id de pedido (transaction_id, order_id, …)
 *   2. `id`/`code`/`hash` que morem dentro de um objeto de pedido — e nunca
 *      dentro de produto, item, cliente ou do descritor do evento
 *   3. `id` na raiz do payload
 */
const CTX_PEDIDO = /(order|transaction|sale|payment|purchase|checkout|pedido|venda)/;
const CTX_PROIBIDO = /(eventtype|event|product|item|customer|buyer|client|cliente|plan|offer|seller|producer|utm)/;

function achaOrderId(ctx) {
  const [, especifico] = acha(ctx, [
    'transactionid', 'orderid', 'saleid', 'paymentid', 'checkoutid',
    'orderreference', 'externalreference', 'ordercode', 'transactioncode',
  ]);
  if (especifico) return especifico;

  for (const nome of ['id', 'code', 'hash', 'reference', 'uuid']) {
    for (const [k, v, cam] of ctx.campos) {
      if (k !== nome || v === '' || v == null) continue;
      const pai = cam.slice(0, cam.length - nome.length);
      if (CTX_PEDIDO.test(pai) && !CTX_PROIBIDO.test(pai)) return v;
    }
  }

  for (const [k, v, cam] of ctx.campos) {
    if ((k === 'id' || k === 'hash') && cam === k && v !== '' && v != null) return v;
  }
  return null;
}

// ── Normalizações ───────────────────────────────────────────────────────────
const STATUS = [
  [/(^|_)(paid|approved|aprovad|complet|success|succeed|confirm|pago|authorized)/i, 'pago'],
  [/(refund|estorn|reembols|devolvid)/i,                                            'estornado'],
  [/(chargeback|charged_back|contestad)/i,                                          'chargeback'],
  [/(abandon)/i,                                                                    'abandonado'],
  [/(refus|denied|declin|reject|recusad|fail|error|erro)/i,                          'recusado'],
  [/(cancel|expir|vencid)/i,                                                        'cancelado'],
  [/(pending|pendent|waiting|aguardand|process|created|criad|analis|generated|gerad)/i, 'pendente'],
];

function normStatus(txt) {
  const s = String(txt || '');
  if (!s) return null;
  for (const [re, nome] of STATUS) if (re.test(s)) return nome;
  return null;
}

const METODOS = [
  [/pix/i, 'pix'],
  [/(credit|debit|card|cartao|cartão)/i, 'cartao'],
  [/(boleto|bank_slip|billet)/i, 'boleto'],
  [/(paypal)/i, 'paypal'],
];

function normMetodo(txt) {
  const s = String(txt || '');
  if (!s) return null;
  for (const [re, nome] of METODOS) if (re.test(s)) return nome;
  return s.slice(0, 20).toLowerCase() || null;
}

/**
 * Valor SEMPRE em centavos.
 *
 * Gateway manda de três jeitos e não avisa qual: 1490 (centavos), 14.90 (reais
 * float) ou "14,90" (reais string). As regras, em ordem:
 *   - nome do campo fala em cents/centavos → é centavos, ponto final
 *   - tem casa decimal → é reais, multiplica por 100
 *   - inteiro < 1000 → reais redondos (R$ 15 → 1500)
 *   - inteiro >= 1000 → centavos (1490 → R$ 14,90)
 * O corte em 1000 é heurística: o produto custa R$ 14,90, então "1490 reais"
 * não existe neste funil. O payload cru fica salvo se precisar reconferir.
 */
function paraCentavos(chave, valor) {
  if (valor == null) return null;
  const ehCents = /cent/.test(String(chave || ''));

  let s = String(valor).trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;

  // "1.234,56" (pt-BR) vs "1234.56" (en)
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');

  const num = Number(s);
  if (!Number.isFinite(num)) return null;

  if (ehCents) return Math.round(num);
  if (!Number.isInteger(num)) return Math.round(num * 100);
  return num < 1000 ? Math.round(num * 100) : Math.round(num);
}

/**
 * Id da visita que gerou a venda.
 *
 * O quiz manda o sid pro checkout na URL (ver irParaCheckout, em Quiz/index.html)
 * usando os nomes que os gateways brasileiros costumam repassar. Como não dá pra
 * saber por qual campo o gateway devolve, procuramos primeiro nos nomes prováveis
 * e depois por FORMATO: o sid é 'bt' + base36, um padrão que não colide com nada
 * mais no payload. É essa varredura por formato que faz o vínculo funcionar
 * mesmo que o campo mude de nome.
 */
const RE_SID = /\bbt[0-9a-z]{12,38}\b/i;

function achaSessao(ctx) {
  const [, direto] = acha(ctx, ['btsid', 'sck', 'src', 'sessionid', 'session', 'tracking', 'trackingid', 'externalid', 'externalreference', 'utmcontent']);
  if (direto && RE_SID.test(String(direto))) return String(direto).match(RE_SID)[0];
  for (const t of ctx.textos) {
    const m = String(t).match(RE_SID);
    if (m) return m[0];
  }
  return null;
}

const str = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    // Vários gateways batem um GET na URL só pra validar que ela responde.
    return res.status(200).json({ ok: true, endpoint: 'webhook-vega', pronto: !!tokenEsperado() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const esperado = tokenEsperado();
  if (!esperado) {
    console.error('webhook-vega: VEGA_WEBHOOK_TOKEN não configurada — notificação recusada');
    return res.status(503).json({ error: 'Webhook sem token configurado no servidor' });
  }
  if (!igual(tokenRecebido(req, body), esperado)) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // ── Extração ──────────────────────────────────────────────────────────────
  const ctx = { campos: [], textos: [] };
  varrer(body, '', ctx, 0, '');

  const [, evento] = acha(ctx, ['eventtype', 'event', 'eventname', 'type', 'hook', 'action', 'description', 'code']);
  const [, statusBruto] = acha(ctx, ['status', 'paymentstatus', 'transactionstatus', 'orderstatus', 'situacao', 'situation', 'state']);
  const status = normStatus(statusBruto) || normStatus(evento) || 'desconhecido';

  const [chaveValor, valorBruto] = acha(ctx, [
    'amountcents', 'totalcents', 'valuecents', 'pricecents',
    'totalvalue', 'totalamount', 'totalprice', 'ordertotal', 'valortotal',
    'amount', 'total', 'value', 'valor', 'price', 'paidamount', 'netamount',
  ]);
  const valorCents = paraCentavos(chaveValor, valorBruto);

  // Sem id do gateway o reenvio duplicaria a venda. O hash do payload é o
  // substituto: mesma notificação = mesma chave = upsert em vez de linha nova.
  const orderId = str(achaOrderId(ctx), 120) ||
    ('sem-id-' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 24));

  const [, email]  = acha(ctx, ['customeremail', 'buyeremail', 'clientemail', 'clienteemail', 'email', 'emailaddress']);
  const [, nome]   = acha(ctx, ['customername', 'buyername', 'clientname', 'clientenome', 'fullname', 'name', 'nome']);
  const [, fone]   = acha(ctx, ['customerphone', 'buyerphone', 'phonenumber', 'phone', 'celular', 'whatsapp', 'telefone']);
  const [, metodo] = acha(ctx, ['paymentmethod', 'paymenttype', 'method', 'formapagamento', 'billingtype']);
  const [, prod]   = acha(ctx, ['productname', 'offername', 'plancode', 'productid', 'product', 'plano', 'produto', 'title']);
  const [, uSrc]   = acha(ctx, ['utmsource', 'source', 'origem']);
  const [, uCamp]  = acha(ctx, ['utmcampaign', 'campaign', 'campanha']);

  const sessionId = achaSessao(ctx);

  let raw = null;
  try {
    const j = JSON.stringify(body);
    raw = j.length > MAX_RAW ? { _truncado: true, tamanho: j.length, inicio: j.slice(0, 4000) } : body;
  } catch (_) { raw = { _erro: 'payload não serializável' }; }

  try {
    await db.initDb();

    await db.query(
      `INSERT INTO bt_orders (
         order_id, session_id, status, evento, valor_cents, metodo, produto,
         cliente_nome, cliente_email, cliente_fone, utm_source, utm_campaign, raw, paid_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $3 = 'pago' THEN NOW() END)
       ON CONFLICT (order_id) DO UPDATE SET
         status        = EXCLUDED.status,
         evento        = COALESCE(EXCLUDED.evento, bt_orders.evento),
         valor_cents   = COALESCE(EXCLUDED.valor_cents, bt_orders.valor_cents),
         metodo        = COALESCE(EXCLUDED.metodo, bt_orders.metodo),
         produto       = COALESCE(EXCLUDED.produto, bt_orders.produto),
         cliente_nome  = COALESCE(EXCLUDED.cliente_nome, bt_orders.cliente_nome),
         cliente_email = COALESCE(EXCLUDED.cliente_email, bt_orders.cliente_email),
         cliente_fone  = COALESCE(EXCLUDED.cliente_fone, bt_orders.cliente_fone),
         session_id    = COALESCE(bt_orders.session_id, EXCLUDED.session_id),
         utm_source    = COALESCE(EXCLUDED.utm_source, bt_orders.utm_source),
         utm_campaign  = COALESCE(EXCLUDED.utm_campaign, bt_orders.utm_campaign),
         raw           = EXCLUDED.raw,
         updated_at    = NOW(),
         -- paid_at é o carimbo da PRIMEIRA aprovação: um estorno depois não
         -- pode apagar o fato de que um dia foi pago.
         paid_at       = COALESCE(bt_orders.paid_at, CASE WHEN EXCLUDED.status = 'pago' THEN NOW() END)`,
      [
        orderId,
        sessionId,
        status,
        str(evento, 60),
        valorCents,
        normMetodo(metodo),
        str(prod, 160),
        str(nome, 160),
        str(email, 160),
        str(fone, 40),
        str(uSrc, 120),
        str(uCamp, 160),
        raw,
      ]
    );

    // Carimba a visita. Só 'pago' marca; estorno/chargeback desmarca — assim a
    // taxa de conversão do painel conta dinheiro que ficou, não que passou.
    if (sessionId) {
      if (status === 'pago') {
        await db.query(
          `UPDATE bt_sessions
              SET purchased = TRUE, purchase_cents = COALESCE($2, purchase_cents), purchase_ts = COALESCE(purchase_ts, NOW())
            WHERE session_id = $1`,
          [sessionId, valorCents]
        );
      } else if (status === 'estornado' || status === 'chargeback') {
        await db.query(`UPDATE bt_sessions SET purchased = FALSE WHERE session_id = $1`, [sessionId]);
      }
    }
  } catch (err) {
    // 500 de propósito: gateway que recebe erro reenvia depois. Engolir aqui
    // seria perder venda em silêncio — o oposto do que se quer numa tabela
    // de dinheiro.
    console.error('webhook-vega:', err.message);
    return res.status(500).json({ error: 'Falha ao gravar o pedido' });
  }

  return res.status(200).json({ ok: true, order_id: orderId, status, session_id: sessionId, valor_cents: valorCents });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '256kb' } } };
