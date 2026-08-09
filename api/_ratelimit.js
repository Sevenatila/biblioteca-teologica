// api/_ratelimit.js
// Rate limit por janela deslizante, guardado no próprio Postgres.
// Serverless não tem memória entre invocações, então contador em RAM não serve.
//
// Política: FAIL-OPEN. Se o banco cair, a checagem libera em vez de bloquear —
// um limitador quebrado nunca pode derrubar a captação de evento nem o login.

const db = require('./_db');

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 45);
  return (req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown')
    .toString().slice(0, 45);
}

/**
 * @param {{key: string, limit: number, windowHours: number}} opts
 * @returns {Promise<{allow: boolean, count: number}>}
 */
async function checkRateLimit({ key, limit, windowHours }) {
  try {
    await db.initDb();
    const minutes = Math.max(1, Math.round(windowHours * 60));
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM bt_rate_limit
        WHERE key = $1 AND ts > NOW() - ($2 || ' minutes')::interval`,
      [key, String(minutes)]
    );
    const count = rows[0] ? rows[0].n : 0;
    if (count >= limit) return { allow: false, count };

    await db.query(`INSERT INTO bt_rate_limit (key) VALUES ($1)`, [key]);

    // Faxina oportunista (~5%): sem isso a tabela cresce pra sempre.
    if (Math.random() < 0.05) {
      db.query(`DELETE FROM bt_rate_limit WHERE ts < NOW() - INTERVAL '24 hours'`).catch(() => {});
    }
    return { allow: true, count: count + 1 };
  } catch (err) {
    console.error('rate limit indisponível (liberando):', err.message);
    return { allow: true, count: 0 };
  }
}

module.exports = { checkRateLimit, getClientIp };
