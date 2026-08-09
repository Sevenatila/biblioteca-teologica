// api/_cors.js
// CORS por lista branca. O quiz e as functions moram no mesmo domínio, então no
// caminho normal nem precisa; isso existe pro caso de você servir o quiz em
// outro domínio (ou testar em localhost) e o /api/track continuar aceitando.
//
// ALLOWED_ORIGINS: lista separada por vírgula nas env vars da Vercel.

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowed(origin) {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  // Previews da Vercel (*.vercel.app) e localhost sempre passam — são seus.
  try {
    const h = new URL(origin).hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (h.endsWith('.vercel.app')) return true;
  } catch (_) {}
  return false;
}

/**
 * Aplica os headers de CORS e responde o preflight.
 * @returns {boolean} true se já respondeu (OPTIONS) — o handler deve dar return.
 */
function applyCors(req, res, opts) {
  const methods = (opts && opts.methods) || 'GET, OPTIONS';
  const origin = req.headers.origin;

  if (isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, isAllowed };
