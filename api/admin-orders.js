// api/admin-orders.js
// Tela "Vendas": quem comprou, quem não comprou, e quanto entrou.
//
// É a única tela alimentada de fora — pelo webhook do gateway
// (api/webhook-vega.js). Todas as outras medem comportamento; esta mede
// dinheiro, que é o único número que decide se o funil presta.
//
// As três perguntas que só esta tela responde:
//   1. Quem comprou? (nome, e-mail, valor, e que nota tirou no quiz)
//   2. Quem foi ao checkout e NÃO comprou? (a lista de resgate)
//   3. Nota baixa converte mais? — agora com venda de verdade, não com clique.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

/** URL que o dono cola no painel do gateway. Só sai daqui pra quem já passou
 *  pelo requireAdmin — o token faz parte dela. */
function urlWebhook(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const token = process.env.VEGA_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || '';
  if (!host) return null;
  const base = `https://${host}/api/webhook-vega`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const O = periodFilter(q, 'o.created_at', 1);
  const S = periodFilter(q, 's.first_ts', 1);

  try {
    await db.initDb();

    // ── Resumo do período ─────────────────────────────────────────────────
    // Receita conta SÓ o que está pago agora: estorno e chargeback saem da
    // conta em vez de virar nota de rodapé.
    const resumo = await db.query(
      `SELECT
         COUNT(*)::int                                                   AS pedidos,
         COUNT(*) FILTER (WHERE o.status = 'pago')::int                  AS pagos,
         COUNT(*) FILTER (WHERE o.status = 'pendente')::int              AS pendentes,
         COUNT(*) FILTER (WHERE o.status IN ('estornado','chargeback'))::int AS estornos,
         COUNT(*) FILTER (WHERE o.status IN ('recusado','cancelado'))::int   AS recusados,
         COUNT(*) FILTER (WHERE o.status = 'abandonado')::int             AS abandonados,
         COALESCE(SUM(o.valor_cents) FILTER (WHERE o.status = 'pago'), 0)::bigint AS receita_cents,
         COUNT(*) FILTER (WHERE o.status = 'pago' AND o.session_id IS NULL)::int  AS pagos_sem_vinculo
       FROM bt_orders o
      WHERE ${O.clause}`,
      O.params
    );

    // ── Checkout → venda ──────────────────────────────────────────────────
    // Vem de bt_sessions, não de bt_orders: o denominador é a visita que
    // clicou em comprar, e essa informação só existe do nosso lado.
    const sess = await db.query(
      `SELECT COUNT(*) FILTER (WHERE s.reached_checkout)::int              AS checkouts,
              COUNT(*) FILTER (WHERE s.purchased)::int                      AS compraram,
              COUNT(*) FILTER (WHERE s.reached_checkout AND NOT s.purchased)::int AS abandonaram
         FROM bt_sessions s
        WHERE ${S.clause}`,
      S.params
    );

    // ── Por dia ───────────────────────────────────────────────────────────
    const porDia = await db.query(
      `SELECT TO_CHAR(o.created_at, 'YYYY-MM-DD') AS dia,
              COUNT(*) FILTER (WHERE o.status = 'pago')::int                       AS pagos,
              COALESCE(SUM(o.valor_cents) FILTER (WHERE o.status = 'pago'), 0)::bigint AS receita_cents
         FROM bt_orders o
        WHERE ${O.clause}
        GROUP BY 1 ORDER BY 1`,
      O.params
    );

    // ── Quem comprou ──────────────────────────────────────────────────────
    // LEFT JOIN: pedido sem sessão vinculada continua aparecendo na lista —
    // ele existe e é dinheiro, mesmo que a gente não saiba de que visita veio.
    const limite = Math.min(300, Math.max(10, parseInt(q.limit, 10) || 100));
    const filtro = String(q.filtro || 'todos');
    const paramsL = [...O.params];
    let whereL = O.clause;
    if (filtro === 'pagos')      whereL += ` AND o.status = 'pago'`;
    else if (filtro === 'pendentes') whereL += ` AND o.status = 'pendente'`;
    else if (filtro === 'problema')  whereL += ` AND o.status IN ('estornado','chargeback','recusado','cancelado')`;
    paramsL.push(limite);

    const pedidos = await db.query(
      `SELECT o.order_id, o.session_id, o.status, o.evento, o.valor_cents, o.metodo,
              o.produto, o.cliente_nome, o.cliente_email, o.cliente_fone,
              o.utm_source, o.utm_campaign, o.created_at, o.paid_at,
              s.score, s.band, s.device, s.max_scroll, s.duration_sec,
              COALESCE(o.utm_source, s.utm_source)     AS origem,
              COALESCE(o.utm_campaign, s.utm_campaign) AS campanha
         FROM bt_orders o
         LEFT JOIN bt_sessions s ON s.session_id = o.session_id
        WHERE ${whereL}
        ORDER BY o.created_at DESC
        LIMIT $${paramsL.length}`,
      paramsL
    );

    // ── Quem foi ao checkout e não comprou ────────────────────────────────
    // A lista de resgate. Quem deixou contato aparece primeiro: é com essa
    // gente que dá pra fazer alguma coisa hoje.
    const paramsA = [...S.params, 40];
    const abandonos = await db.query(
      `SELECT s.session_id, s.first_ts, s.device, s.score, s.band, s.contact,
              s.max_scroll, s.duration_sec, s.cta_clicks, s.utm_source, s.utm_campaign
         FROM bt_sessions s
        WHERE ${S.clause} AND s.reached_checkout AND NOT s.purchased
        ORDER BY s.contact DESC, s.first_ts DESC
        LIMIT $${paramsA.length}`,
      paramsA
    );

    // ── A nota do quiz compra? ────────────────────────────────────────────
    // A hipótese que sustenta o funil inteiro — aqui julgada por venda paga,
    // não por clique no botão.
    const porFaixa = await db.query(
      `SELECT s.band,
              COUNT(*)::int                                  AS sessoes,
              COUNT(*) FILTER (WHERE s.reached_checkout)::int AS checkouts,
              COUNT(*) FILTER (WHERE s.purchased)::int        AS compras,
              COALESCE(SUM(s.purchase_cents) FILTER (WHERE s.purchased), 0)::bigint AS receita_cents
         FROM bt_sessions s
        WHERE ${S.clause} AND s.band IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      S.params
    );

    // ── Origem que traz dinheiro ──────────────────────────────────────────
    const porOrigem = await db.query(
      `SELECT COALESCE(NULLIF(s.utm_source, ''), 'direto') AS origem,
              COUNT(*)::int                            AS sessoes,
              COUNT(*) FILTER (WHERE s.purchased)::int  AS compras,
              COALESCE(SUM(s.purchase_cents) FILTER (WHERE s.purchased), 0)::bigint AS receita_cents
         FROM bt_sessions s
        WHERE ${S.clause}
        GROUP BY 1
        HAVING COUNT(*) > 0
        ORDER BY 4 DESC, 2 DESC
        LIMIT 12`,
      S.params
    );

    const r = resumo.rows[0] || {};
    const pagos = Number(r.pagos || 0);

    return res.status(200).json({
      resumo: {
        pedidos:      Number(r.pedidos || 0),
        pagos,
        pendentes:    Number(r.pendentes || 0),
        estornos:     Number(r.estornos || 0),
        recusados:    Number(r.recusados || 0),
        abandonados:  Number(r.abandonados || 0),
        receita_cents: Number(r.receita_cents || 0),
        ticket_cents:  pagos ? Math.round(Number(r.receita_cents || 0) / pagos) : 0,
        pagos_sem_vinculo: Number(r.pagos_sem_vinculo || 0),
        checkouts:    Number(sess.rows[0] ? sess.rows[0].checkouts : 0),
        compraram:    Number(sess.rows[0] ? sess.rows[0].compraram : 0),
        abandonaram:  Number(sess.rows[0] ? sess.rows[0].abandonaram : 0),
      },
      porDia:    porDia.rows,
      pedidos:   pedidos.rows,
      abandonos: abandonos.rows,
      porFaixa:  porFaixa.rows,
      porOrigem: porOrigem.rows,
      webhook: {
        url: urlWebhook(req),
        configurado: !!(process.env.VEGA_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN),
      },
    });
  } catch (err) {
    console.error('admin-orders:', err.message);
    return res.status(500).json({ error: 'Falha ao ler as vendas', detail: err.message });
  }
};
