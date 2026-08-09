// api/admin-quiz.js
// Tela "Perguntas": o desempenho do quiz em si.
//
// É a tela que só existe porque aqui o produto é um quiz, não uma LP. Três
// perguntas que só estes dados respondem:
//   1. Qual mito mais pega gente? (taxa de erro por pergunta)
//   2. Em que pergunta as pessoas largam? (abandono por índice)
//   3. Que nota o público tira — e as notas baixas compram mais?

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const E = periodFilter(q, 'ts', 1);
  const S = periodFilter(q, 'first_ts', 1);

  try {
    await db.initDb();

    // ── Acerto e erro por pergunta ────────────────────────────────────────
    // section = q1..q10, label = 'hit' ou 'miss'. Ordenado pelo número da
    // pergunta (não alfabético — senão q10 viria depois de q1).
    const perguntas = await db.query(
      `SELECT section,
              COUNT(*)::int                                AS respostas,
              COUNT(*) FILTER (WHERE label = 'hit')::int   AS acertos,
              COUNT(*) FILTER (WHERE label = 'miss')::int  AS erros
         FROM bt_events
        WHERE event_name = 'quiz_answer' AND section IS NOT NULL AND ${E.clause}
        GROUP BY 1
        ORDER BY NULLIF(REGEXP_REPLACE(section, '\\D', '', 'g'), '')::int NULLS LAST`,
      E.params
    );

    // ── Onde larga o quiz ─────────────────────────────────────────────────
    // max_q = última pergunta respondida. Quem parou em 3 respondeu 3 e sumiu.
    const abandono = await db.query(
      `SELECT max_q, COUNT(*)::int AS sessoes
         FROM bt_sessions
        WHERE ${S.clause} AND max_q < 10
        GROUP BY 1 ORDER BY 1`,
      S.params
    );

    // ── Distribuição das notas + o que cada nota faz depois ───────────────
    // A hipótese do funil é que nota baixa converte melhor (o quiz existe pra
    // criar a lacuna). Esta tabela confirma ou derruba isso.
    const notas = await db.query(
      `SELECT score,
              COUNT(*)::int                                   AS sessoes,
              COUNT(*) FILTER (WHERE cta_clicks > 0)::int     AS ctas,
              COUNT(*) FILTER (WHERE reached_checkout)::int   AS checkouts
         FROM bt_sessions
        WHERE ${S.clause} AND score IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      S.params
    );

    // ── Por faixa de resultado ────────────────────────────────────────────
    // As 4 faixas da função band() do quiz. Cada uma vê um título e um
    // diagnóstico diferentes — logo, é uma oferta diferente.
    const faixas = await db.query(
      `SELECT band,
              COUNT(*)::int                                   AS sessoes,
              COUNT(*) FILTER (WHERE cta_clicks > 0)::int     AS ctas,
              COUNT(*) FILTER (WHERE reached_checkout)::int   AS checkouts,
              COALESCE(ROUND(AVG(max_scroll)::numeric, 1), 0) AS scroll_medio
         FROM bt_sessions
        WHERE ${S.clause} AND band IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      S.params
    );

    return res.status(200).json({
      perguntas: perguntas.rows,
      abandono:  abandono.rows,
      notas:     notas.rows,
      faixas:    faixas.rows,
    });
  } catch (err) {
    console.error('admin-quiz:', err.message);
    return res.status(500).json({ error: 'Falha ao ler o desempenho do quiz', detail: err.message });
  }
};
