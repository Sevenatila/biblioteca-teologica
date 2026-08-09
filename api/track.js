// api/track.js
// Ingestão pública: chega do navegador do visitante, via navigator.sendBeacon.
//
// Três coisas num POST só (o cliente manda em lote pra não pipocar requisição):
//   events[]  → funil, respostas do quiz e log
//   clicks[]  → mapa de calor (só da tela de resultado — ver js/track.js)
//   session{} → nota, faixa, tempo, rolagem, origem, aparelho (UPSERT)
//
// Regras de ouro desta rota:
//   1. NUNCA quebra o quiz — todo erro é engolido e a resposta é 200.
//   2. Whitelist rígida de nomes de evento — senão vira depósito de lixo.
//   3. Tetos por lote — um cliente malicioso não enche o banco numa tacada.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { checkRateLimit, getClientIp } = require('./_ratelimit');

// ── Funil do quiz ───────────────────────────────────────────────────────────
// step_index é a ORDEM no funil. O painel monta o funil cumulativo com ele:
// quem chegou no passo N necessariamente passou pelos anteriores.
const STEP_INDEX = {
  visit:          0,  // abriu o quiz
  quiz_start:     1,  // respondeu a 1ª pergunta
  quiz_half:      2,  // respondeu a 5ª
  quiz_finish:    3,  // respondeu a 10ª
  capture_view:   4,  // viu a tela de "onde enviamos sua análise"
  result_view:    5,  // ← A ÚLTIMA PÁGINA. É daqui pra frente que o calor conta.
  offer_view:     6,  // rolou até o bloco de preço
  cta_click:      7,  // clicou num botão de compra
  checkout_click: 8,  // saiu pro checkout
};

// Engajamento: entra no log e nos gráficos, mas NÃO é degrau do funil (step 0).
// Misturar as duas coisas é o que faz funil mentir.
const ENGAJAMENTO = new Set([
  'quiz_answer',    // respondeu uma pergunta (label = hit|miss, section = q1..q10)
  'capture_submit', // deixou e-mail/WhatsApp
  'capture_skip',   // pulou a captura
  'section_view',   // uma seção da tela de resultado entrou na tela
  'scroll_25', 'scroll_50', 'scroll_75', 'scroll_90', // rolagem DENTRO do resultado
  'faq_open',       // abriu uma pergunta do FAQ
  'rage_click',     // 3+ cliques no mesmo ponto em 1s = frustração
  'exit',           // saiu da página
]);

const ALLOWED = new Set([...Object.keys(STEP_INDEX), ...ENGAJAMENTO]);

const MAX_EVENTS = 40;
const MAX_CLICKS = 60;

const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
const faixa = (v) => { const n = Number(v); return n >= 1 && n <= 4 ? n : null; };

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'POST, OPTIONS' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 300 lotes/hora por IP. Um quiz inteiro manda poucos lotes; isso segura
  // abuso sem pegar visitante real. Fail-open (ver _ratelimit).
  try {
    const rl = await checkRateLimit({ key: 'track:' + getClientIp(req), limit: 300, windowHours: 1 });
    if (!rl.allow) return res.status(200).json({ ok: true, skipped: true });
  } catch (_) {}

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sessionId = str(body.sessionId, 40) || '';
  if (!/^[a-zA-Z0-9_-]{8,40}$/.test(sessionId)) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  const device = ['mobile', 'tablet', 'desktop'].includes(body.device) ? body.device : null;

  try {
    await db.initDb();
  } catch (err) {
    console.error('initDb falhou (silencioso):', err.message);
    return res.status(200).json({ ok: true });
  }

  // ── 1. SESSÃO (upsert) ────────────────────────────────────────────────────
  // Os campos "de pico" (max_q, max_scroll, duration, cta_clicks) usam GREATEST
  // no update: lotes podem chegar fora de ordem e a sessão nunca pode regredir.
  const s = body.session;
  if (s && typeof s === 'object') {
    try {
      await db.query(
        `INSERT INTO bt_sessions (
           session_id, device, vw, referrer, landing_path,
           utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, country,
           max_q, score, band, contact, reached_result,
           max_scroll, last_section, duration_sec, cta_clicks, reached_checkout
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (session_id) DO UPDATE SET
           last_ts          = NOW(),
           max_q            = GREATEST(bt_sessions.max_q, EXCLUDED.max_q),
           score            = COALESCE(EXCLUDED.score, bt_sessions.score),
           band             = COALESCE(EXCLUDED.band, bt_sessions.band),
           contact          = bt_sessions.contact OR EXCLUDED.contact,
           reached_result   = bt_sessions.reached_result OR EXCLUDED.reached_result,
           max_scroll       = GREATEST(bt_sessions.max_scroll, EXCLUDED.max_scroll),
           duration_sec     = GREATEST(bt_sessions.duration_sec, EXCLUDED.duration_sec),
           cta_clicks       = GREATEST(bt_sessions.cta_clicks, EXCLUDED.cta_clicks),
           reached_checkout = bt_sessions.reached_checkout OR EXCLUDED.reached_checkout,
           last_section     = COALESCE(EXCLUDED.last_section, bt_sessions.last_section)`,
        [
          sessionId,
          device,
          num(s.vw),
          str(s.referrer, 500),
          str(s.path, 200),
          str(s.utm_source, 120),
          str(s.utm_medium, 120),
          str(s.utm_campaign, 160),
          str(s.utm_content, 160),
          str(s.utm_term, 160),
          str(s.fbclid, 255),
          str(req.headers['x-vercel-ip-country'], 2),
          Math.min(10, Math.max(0, num(s.maxQ) || 0)),
          s.score == null ? null : Math.min(10, Math.max(0, num(s.score) || 0)),
          faixa(s.band),
          !!s.contact,
          !!s.reachedResult,
          Math.min(100, Math.max(0, num(s.maxScroll) || 0)),
          str(s.lastSection, 40),
          Math.min(86400, Math.max(0, num(s.duration) || 0)),
          Math.min(999, Math.max(0, num(s.ctaClicks) || 0)),
          !!s.reachedCheckout,
        ]
      );
    } catch (err) {
      console.error('upsert sessão (silencioso):', err.message);
    }
  }

  // ── 2. EVENTOS (insert em lote) ───────────────────────────────────────────
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  const evRows = [];
  for (const ev of events) {
    const name = str(ev && ev.name, 60);
    if (!name || !ALLOWED.has(name)) continue;
    evRows.push([sessionId, name, STEP_INDEX[name] || 0, str(ev.section, 40), str(ev.label, 120), device]);
  }
  if (evRows.length) {
    try {
      const vals = [];
      const ph = evRows.map((r, i) => {
        const b = i * 6;
        vals.push(...r);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
      }).join(',');
      await db.query(
        `INSERT INTO bt_events (session_id, event_name, step_index, section, label, device)
         VALUES ${ph}`,
        vals
      );
    } catch (err) {
      console.error('insert eventos (silencioso):', err.message);
    }
  }

  // ── 3. CLIQUES / MAPA DE CALOR ────────────────────────────────────────────
  const clicks = Array.isArray(body.clicks) ? body.clicks.slice(0, MAX_CLICKS) : [];
  const clRows = [];
  for (const c of clicks) {
    const x = clamp01(c && c.x), y = clamp01(c && c.y);
    if (x == null || y == null) continue;
    clRows.push([
      sessionId, str(c.section, 40), str(c.label, 120),
      x, y, clamp01(c.secPct), !!c.isCta, !!c.dead,
      device, faixa(c.band), num(c.vw), num(c.vh),
    ]);
  }
  if (clRows.length) {
    try {
      const vals = [];
      const ph = clRows.map((r, i) => {
        const b = i * 12;
        vals.push(...r);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`;
      }).join(',');
      await db.query(
        `INSERT INTO bt_clicks (session_id, section, label, x_pct, y_pct, sec_pct, is_cta, dead, device, band, vw, vh)
         VALUES ${ph}`,
        vals
      );
    } catch (err) {
      console.error('insert cliques (silencioso):', err.message);
    }
  }

  // ── 4. Autolimpeza oportunista (~2% das chamadas) ─────────────────────────
  // O painel só olha 30 dias. Sem isso a conta do banco cresce pra sempre.
  if (Math.random() < 0.02) {
    db.query(`DELETE FROM bt_events WHERE ts < NOW() - INTERVAL '30 days'`).catch(() => {});
    db.query(`DELETE FROM bt_clicks WHERE ts < NOW() - INTERVAL '30 days'`).catch(() => {});
    db.query(`DELETE FROM bt_sessions WHERE first_ts < NOW() - INTERVAL '90 days'`).catch(() => {});
  }

  return res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '128kb' } } };
