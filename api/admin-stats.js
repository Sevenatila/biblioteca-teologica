// api/admin-stats.js
// Tela "Visão Geral": os números do topo + séries por dia, aparelho e origem.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const S = periodFilter(q, 's.first_ts', 1);

  try {
    await db.initDb();

    // ── Resumo ────────────────────────────────────────────────────────────
    // "desistiu na cara" = abriu e não respondeu nem a primeira pergunta.
    // É o critério honesto pra um quiz: bateu o olho na capa e foi embora.
    //
    // tempo_medio/scroll_medio de quem CHEGOU no resultado — média com quem
    // nem viu a oferta não diria nada sobre a oferta.
    const resumo = await db.query(
      `SELECT
         COUNT(*)::int                                            AS sessoes,
         COUNT(*) FILTER (WHERE s.max_q > 0)::int                 AS comecaram,
         COUNT(*) FILTER (WHERE s.max_q >= 10)::int               AS terminaram,
         COUNT(*) FILTER (WHERE s.contact)::int                   AS contatos,
         COUNT(*) FILTER (WHERE s.reached_result)::int            AS viram_oferta,
         COUNT(*) FILTER (WHERE s.cta_clicks > 0)::int            AS com_cta,
         COUNT(*) FILTER (WHERE s.reached_checkout)::int          AS checkouts,
         COUNT(*) FILTER (WHERE s.purchased)::int                 AS compras,
         COALESCE(SUM(s.purchase_cents) FILTER (WHERE s.purchased), 0)::bigint AS receita_cents,
         COUNT(*) FILTER (WHERE s.max_q = 0)::int                 AS saiu_na_cara,
         COALESCE(ROUND(CAST(AVG(s.score) AS numeric), 1), 0)     AS nota_media,
         COALESCE(ROUND(AVG(s.duration_sec)::numeric, 1), 0)      AS tempo_medio,
         COALESCE(ROUND(CAST(AVG(s.max_scroll) FILTER (WHERE s.reached_result) AS numeric), 1), 0) AS scroll_oferta,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.duration_sec), 0) AS tempo_mediano
       FROM bt_sessions s
       WHERE ${S.clause}`,
      S.params
    );

    // ── Série por dia ─────────────────────────────────────────────────────
    const porDia = await db.query(
      `SELECT
         TO_CHAR(s.first_ts, 'YYYY-MM-DD')                 AS dia,
         COUNT(*)::int                                     AS sessoes,
         COUNT(*) FILTER (WHERE s.max_q >= 10)::int        AS terminaram,
         COUNT(*) FILTER (WHERE s.reached_result)::int     AS ofertas,
         COUNT(*) FILTER (WHERE s.reached_checkout)::int   AS checkouts
       FROM bt_sessions s
       WHERE ${S.clause}
       GROUP BY 1 ORDER BY 1`,
      S.params
    );

    // ── Aparelho ──────────────────────────────────────────────────────────
    // O quiz é mobile first — esse corte diz se a premissa está certa.
    const porDispositivo = await db.query(
      `SELECT
         COALESCE(s.device, 'desconhecido')                AS device,
         COUNT(*)::int                                     AS sessoes,
         COUNT(*) FILTER (WHERE s.max_q >= 10)::int        AS terminaram,
         COUNT(*) FILTER (WHERE s.reached_checkout)::int   AS checkouts,
         COALESCE(ROUND(AVG(s.duration_sec)::numeric, 1), 0) AS tempo_medio
       FROM bt_sessions s
       WHERE ${S.clause}
       GROUP BY 1 ORDER BY sessoes DESC`,
      S.params
    );

    // ── Origem do tráfego ─────────────────────────────────────────────────
    const porOrigem = await db.query(
      `SELECT
         COALESCE(NULLIF(s.utm_source,''), 'direto')       AS origem,
         COALESCE(NULLIF(s.utm_campaign,''), '—')          AS campanha,
         COUNT(*)::int                                     AS sessoes,
         COUNT(*) FILTER (WHERE s.max_q >= 10)::int        AS terminaram,
         COUNT(*) FILTER (WHERE s.reached_checkout)::int   AS checkouts
       FROM bt_sessions s
       WHERE ${S.clause}
       GROUP BY 1,2 ORDER BY sessoes DESC LIMIT 25`,
      S.params
    );

    const r = resumo.rows[0] || {};
    return res.status(200).json({
      resumo: {
        sessoes:       Number(r.sessoes || 0),
        comecaram:     Number(r.comecaram || 0),
        terminaram:    Number(r.terminaram || 0),
        contatos:      Number(r.contatos || 0),
        viram_oferta:  Number(r.viram_oferta || 0),
        com_cta:       Number(r.com_cta || 0),
        checkouts:     Number(r.checkouts || 0),
        compras:       Number(r.compras || 0),
        receita_cents: Number(r.receita_cents || 0),
        saiu_na_cara:  Number(r.saiu_na_cara || 0),
        nota_media:    Number(r.nota_media || 0),
        tempo_medio:   Number(r.tempo_medio || 0),
        tempo_mediano: Number(r.tempo_mediano || 0),
        scroll_oferta: Number(r.scroll_oferta || 0),
      },
      porDia:         porDia.rows,
      porDispositivo: porDispositivo.rows,
      porOrigem:      porOrigem.rows,
    });
  } catch (err) {
    console.error('admin-stats:', err.message);
    return res.status(500).json({ error: 'Falha ao ler as métricas', detail: err.message });
  }
};
