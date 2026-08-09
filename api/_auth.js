// api/_auth.js
// Guarda das rotas /api/admin-*. Todas elas exigem o JWT emitido pelo login.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Segredo de assinatura do JWT.
 *
 * A ideia aqui é o painel subir com DUAS variáveis de ambiente, não quatro:
 * POSTGRES_URL e PAINEL_SENHA. Sem JWT_SECRET configurado, o segredo é
 * DERIVADO da senha — determinístico, então todas as functions chegam no mesmo
 * valor sem precisar combinar nada, e trocar a senha invalida as sessões
 * abertas de brinde (que é o comportamento desejado).
 *
 * Se um dia você quiser separar as duas coisas, basta definir JWT_SECRET: ela
 * tem precedência e a derivação nem roda.
 */
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const senha = process.env.PAINEL_SENHA;
  if (!senha) return null;
  return crypto.createHash('sha256').update('bt-painel|v1|' + senha).digest('hex');
}

/**
 * Valida o Bearer token. Se falhar, já responde e devolve null —
 * o handler só precisa checar `if (!requireAdmin(req, res)) return;`
 */
function requireAdmin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const secret = jwtSecret();
  if (!secret) {
    res.status(500).json({ error: 'Servidor sem PAINEL_SENHA configurada' });
    return null;
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Não autenticado' });
    return null;
  }

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (payload.role !== 'admin') {
      res.status(403).json({ error: 'Sem permissão' });
      return null;
    }
    return payload;
  } catch (_) {
    res.status(401).json({ error: 'Sessão expirada' });
    return null;
  }
}

/**
 * Converte ?from=&to= (YYYY-MM-DD) numa cláusula SQL segura.
 * Sem período informado devolve os últimos 30 dias — o painel nunca varre a
 * tabela inteira por acidente.
 * @returns {{clause: string, params: any[], nextIdx: number}}
 */
function periodFilter(query, column, startIdx) {
  const idx = startIdx || 1;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : null;

  if (from && to) {
    return {
      clause: `${column} >= $${idx}::date AND ${column} < ($${idx + 1}::date + INTERVAL '1 day')`,
      params: [from, to],
      nextIdx: idx + 2,
    };
  }
  if (from) {
    return { clause: `${column} >= $${idx}::date`, params: [from], nextIdx: idx + 1 };
  }
  return { clause: `${column} > NOW() - INTERVAL '30 days'`, params: [], nextIdx: idx };
}

module.exports = { requireAdmin, periodFilter, jwtSecret };
