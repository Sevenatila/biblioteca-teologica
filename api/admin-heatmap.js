// api/admin-heatmap.js
// Tela "Mapa de Calor": onde o dedo do visitante encosta NA TELA DE RESULTADO.
//
// Por que só a tela de resultado: o quiz é uma SPA. As 10 perguntas, a captura
// e o resultado moram todos em /Quiz/, com alturas e conteúdos diferentes. Um
// mapa que somasse tudo não significaria nada — y_pct de telas diferentes não
// se compara. O rastreio de clique já sai filtrado do navegador (js/track.js),
// então aqui não é preciso peneirar de novo.
//
// O painel NÃO recebe milhares de pontos crus — isso travaria o navegador e
// gastaria banda à toa. O agrupamento acontece aqui no Postgres: a página é
// dividida numa grade e o que viaja é a contagem por célula.
//
// ?device=  mobile | tablet | desktop — o mapa MUDA muito entre eles
// ?band=    1..4, a faixa do resultado. A página é diferente por faixa (título
//           e chips de mito mudam), então o mapa também é.
// ?section= limita a um bloco da oferta

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const cols = Math.min(120, Math.max(20, parseInt(q.cols, 10) || 60));
  const rows = Math.min(400, Math.max(50, parseInt(q.rows, 10) || 220));
  const device = ['mobile', 'tablet', 'desktop'].includes(q.device) ? q.device : null;
  const band = [1, 2, 3, 4].includes(parseInt(q.band, 10)) ? parseInt(q.band, 10) : null;

  const C = periodFilter(q, 'ts', 1);
  const params = [...C.params];
  let where = C.clause;
  if (device) { params.push(device); where += ` AND device = $${params.length}`; }
  if (band)   { params.push(band);   where += ` AND band = $${params.length}`; }
  if (q.section) {
    params.push(String(q.section).slice(0, 40));
    where += ` AND section = $${params.length}`;
  }

  try {
    await db.initDb();

    // ── Grade de calor ────────────────────────────────────────────────────
    // FLOOR(x * cols) joga cada clique na sua célula. O painel pinta a célula
    // com intensidade proporcional a n / maior_n.
    params.push(cols, rows);
    const iCols = params.length - 1, iRows = params.length;
    const grade = await db.query(
      `SELECT
         LEAST($${iCols}::int - 1, FLOOR(x_pct * $${iCols}::int))::int AS gx,
         LEAST($${iRows}::int - 1, FLOOR(y_pct * $${iRows}::int))::int AS gy,
         COUNT(*)::int                       AS n,
         COUNT(*) FILTER (WHERE is_cta)::int AS n_cta,
         COUNT(*) FILTER (WHERE dead)::int   AS n_mortos
       FROM bt_clicks
       WHERE ${where}
       GROUP BY 1,2
       ORDER BY n DESC
       LIMIT 4000`,
      params
    );

    const baseParams = params.slice(0, params.length - 2);

    // ── Ranking de elementos clicados ─────────────────────────────────────
    const elementos = await db.query(
      `SELECT COALESCE(label, '(sem rótulo)') AS label,
              COALESCE(section, '—')          AS section,
              COUNT(*)::int                   AS cliques,
              COUNT(DISTINCT session_id)::int AS sessoes,
              BOOL_OR(is_cta)                 AS is_cta
         FROM bt_clicks
        WHERE ${where}
        GROUP BY 1,2 ORDER BY cliques DESC LIMIT 40`,
      baseParams
    );

    // ── Cliques mortos ────────────────────────────────────────────────────
    // Gente clicando em coisa que não é clicável. Cada linha aqui é um texto
    // ou selo que PARECE botão — dinheiro parado na mesa.
    const mortos = await db.query(
      `SELECT COALESCE(section, '—')            AS section,
              COALESCE(label, '(área sem ação)') AS label,
              COUNT(*)::int                     AS cliques,
              COUNT(DISTINCT session_id)::int   AS sessoes
         FROM bt_clicks
        WHERE ${where} AND dead
        GROUP BY 1,2 ORDER BY cliques DESC LIMIT 20`,
      baseParams
    );

    // ── Cliques por seção ─────────────────────────────────────────────────
    const porSecao = await db.query(
      `SELECT COALESCE(section, '—') AS section,
              COUNT(*)::int                       AS cliques,
              COUNT(*) FILTER (WHERE is_cta)::int  AS cta,
              COUNT(*) FILTER (WHERE dead)::int    AS mortos,
              COUNT(DISTINCT session_id)::int      AS sessoes
         FROM bt_clicks
        WHERE ${where}
        GROUP BY 1 ORDER BY cliques DESC`,
      baseParams
    );

    // ── Curva de rolagem da tela de oferta ────────────────────────────────
    // Só sessões que CHEGARAM no resultado — as outras nunca tiveram o que
    // rolar, e incluí-las achataria a curva inteira pra baixo.
    const S = periodFilter(q, 'first_ts', 1);
    const sParams = [...S.params];
    let sWhere = S.clause + ' AND reached_result';
    if (device) { sParams.push(device); sWhere += ` AND device = $${sParams.length}`; }
    if (band)   { sParams.push(band);   sWhere += ` AND band = $${sParams.length}`; }

    const rolagem = await db.query(
      `WITH t AS (SELECT COUNT(*)::numeric AS total FROM bt_sessions WHERE ${sWhere})
       SELECT g.d AS ate,
              COUNT(s.session_id)::int AS sessoes,
              CASE WHEN (SELECT total FROM t) > 0
                   THEN ROUND(COUNT(s.session_id) * 100.0 / (SELECT total FROM t), 1)
                   ELSE 0 END AS pct
         FROM generate_series(10, 100, 10) AS g(d)
         LEFT JOIN bt_sessions s ON s.max_scroll >= g.d AND ${sWhere}
        GROUP BY g.d ORDER BY g.d`,
      sParams
    );

    const total = grade.rows.reduce((a, r) => a + Number(r.n), 0);
    const pico = grade.rows.reduce((m, r) => Math.max(m, Number(r.n)), 0);

    return res.status(200).json({
      grade: { cols, rows, pico, total, celulas: grade.rows },
      elementos: elementos.rows,
      mortos:    mortos.rows,
      porSecao:  porSecao.rows,
      rolagem:   rolagem.rows,
      filtro:    { device: device || 'todos', band: band || null, section: q.section || null },
    });
  } catch (err) {
    console.error('admin-heatmap:', err.message);
    return res.status(500).json({ error: 'Falha ao montar o mapa de calor', detail: err.message });
  }
};
