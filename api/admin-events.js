// api/admin-events.js
// Tela "Eventos": o log cru, pra conferir se o rastreio está chegando.
// É a primeira tela que se abre quando o painel parece zerado: se aqui tem
// linha, o problema é de leitura; se está vazio, é de captação.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const E = periodFilter(q, 'ts', 1);
  const params = [...E.params];
  let where = E.clause;

  if (q.name) {
    params.push(String(q.name).slice(0, 60));
    where += ` AND event_name = $${params.length}`;
  }
  if (q.session) {
    params.push(String(q.session).slice(0, 40));
    where += ` AND session_id = $${params.length}`;
  }

  const limit = Math.min(300, Math.max(10, parseInt(q.limit, 10) || 150));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);

  try {
    await db.initDb();

    // Resumo por tipo — útil pra bater o olho e ver o que ainda não chegou.
    const porTipo = await db.query(
      `SELECT event_name,
              COUNT(*)::int                   AS n,
              COUNT(DISTINCT session_id)::int AS sessoes,
              MAX(ts)                         AS ultimo
         FROM bt_events WHERE ${E.clause}
        GROUP BY 1 ORDER BY n DESC`,
      E.params
    );

    const total = await db.query(`SELECT COUNT(*)::int AS n FROM bt_events WHERE ${where}`, params);

    params.push(limit, offset);
    const linhas = await db.query(
      `SELECT id, session_id, event_name, step_index, section, label, device, ts
         FROM bt_events WHERE ${where}
        ORDER BY ts DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const n = Number(total.rows[0] ? total.rows[0].n : 0);
    return res.status(200).json({
      porTipo: porTipo.rows,
      total:   n,
      eventos: linhas.rows,
      hasMore: offset + linhas.rows.length < n,
    });
  } catch (err) {
    console.error('admin-events:', err.message);
    return res.status(500).json({ error: 'Falha ao ler os eventos', detail: err.message });
  }
};
