// api/admin-login.js
// Login do painel — só senha, nada de usuário. A senha vive na env var
// PAINEL_SENHA da Vercel; nunca no HTML, que é o erro clássico de painel caseiro.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { applyCors } = require('./_cors');
const { jwtSecret } = require('./_auth');
const { checkRateLimit, getClientIp } = require('./_ratelimit');

// Comparação em tempo constante: com `===` o tempo de resposta vaza quantos
// caracteres iniciais bateram. Aqui não vaza.
function mesmaSenha(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  if (applyCors(req, res, { methods: 'POST, OPTIONS' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 10 tentativas / 10 min por IP. Você é o único que loga aqui: 10 é folga de
  // sobra pra você e parede pra quem estiver chutando senha.
  const rl = await checkRateLimit({ key: 'login:' + getClientIp(req), limit: 10, windowHours: 0.1667 });
  if (!rl.allow) return res.status(429).json({ error: 'Muitas tentativas. Espere alguns minutos.' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const senha = (body && body.senha) || '';

    const SENHA = process.env.PAINEL_SENHA;
    const SECRET = jwtSecret();
    if (!SENHA || !SECRET) {
      return res.status(500).json({ error: 'Servidor sem PAINEL_SENHA configurada' });
    }

    if (!mesmaSenha(senha, SENHA)) {
      await new Promise(r => setTimeout(r, 800)); // atraso artificial contra força bruta
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const token = jwt.sign(
      { role: 'admin', iat: Math.floor(Date.now() / 1000) },
      SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );
    return res.status(200).json({ token });
  } catch (err) {
    console.error('Erro no login:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
