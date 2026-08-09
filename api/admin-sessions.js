// api/admin-sessions.js
// Tela "Sessões": a lista de visitas e a jornada individual.
//
// Sem ?id= → lista paginada, com filtro por comportamento.
// Com ?id= → a linha do tempo daquela visita, evento por evento.
//   Ver 5 jornadas de quem chegou na oferta e não clicou ensina mais que
//   qualquer média.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};

  try {
    await db.initDb();

    // ── Detalhe de uma sessão ─────────────────────────────────────────────
    if (q.id) {
      const id = String(q.id).slice(0, 40);

      const sessao = await db.query(`SELECT * FROM bt_sessions WHERE session_id = $1`, [id]);
      if (!sessao.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });

      const eventos = await db.query(
        `SELECT event_name, step_index, section, label, ts
           FROM bt_events WHERE session_id = $1 ORDER BY ts ASC LIMIT 500`,
        [id]
      );
      const cliques = await db.query(
        `SELECT section, label, x_pct, y_pct, is_cta, dead, ts
           FROM bt_clicks WHERE session_id = $1 ORDER BY ts ASC LIMIT 300`,
        [id]
      );

      // O que aconteceu depois que a pessoa saiu daqui — chega pelo webhook do
      // gateway. Uma visita pode ter mais de um pedido (pix que expirou e uma
      // segunda tentativa no cartão, por exemplo).
      const pedidos = await db.query(
        `SELECT order_id, status, valor_cents, metodo, produto,
                cliente_nome, cliente_email, created_at, paid_at
           FROM bt_orders WHERE session_id = $1 ORDER BY created_at ASC LIMIT 20`,
        [id]
      );

      return res.status(200).json({
        sessao:  sessao.rows[0],
        eventos: eventos.rows,
        cliques: cliques.rows,
        pedidos: pedidos.rows,
      });
    }

    // ── Lista ─────────────────────────────────────────────────────────────
    const S = periodFilter(q, 's.first_ts', 1);
    const params = [...S.params];
    let where = S.clause;

    const filtro = String(q.filtro || 'all');
    if (filtro === 'comprou')       where += ` AND s.purchased`;
    else if (filtro === 'nao-comprou') where += ` AND s.reached_checkout AND NOT s.purchased`;
    else if (filtro === 'checkout') where += ` AND s.reached_checkout`;
    else if (filtro === 'cta')      where += ` AND s.cta_clicks > 0 AND NOT s.reached_checkout`;
    else if (filtro === 'oferta')   where += ` AND s.reached_result AND s.cta_clicks = 0`;
    else if (filtro === 'largou')   where += ` AND s.max_q > 0 AND s.max_q < 10`;
    else if (filtro === 'na-cara')  where += ` AND s.max_q = 0`;
    else if (filtro === 'contato')  where += ` AND s.contact`;

    if (q.device && ['mobile', 'tablet', 'desktop'].includes(q.device)) {
      params.push(q.device);
      where += ` AND s.device = $${params.length}`;
    }

    const limit = Math.min(200, Math.max(10, parseInt(q.limit, 10) || 60));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    const total = await db.query(`SELECT COUNT(*)::int AS n FROM bt_sessions s WHERE ${where}`, params);

    params.push(limit, offset);
    const lista = await db.query(
      `SELECT s.session_id, s.first_ts, s.device, s.max_q, s.score, s.band, s.contact,
              s.reached_result, s.max_scroll, s.last_section, s.duration_sec,
              s.cta_clicks, s.reached_checkout, s.utm_source, s.utm_campaign,
              s.country, s.referrer, s.purchased, s.purchase_cents
         FROM bt_sessions s
        WHERE ${where}
        ORDER BY s.first_ts DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const n = Number(total.rows[0] ? total.rows[0].n : 0);
    return res.status(200).json({
      total: n,
      sessoes: lista.rows,
      hasMore: offset + lista.rows.length < n,
    });
  } catch (err) {
    console.error('admin-sessions:', err.message);
    return res.status(500).json({ error: 'Falha ao ler as sessões', detail: err.message });
  }
};
