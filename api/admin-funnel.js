// api/admin-funnel.js
// Tela "Funil": onde a visita morre.
//
// Três leituras complementares:
//   1. FUNIL POR PASSO — abriu → quiz → resultado → oferta → checkout
//   2. ALCANCE POR SEÇÃO — quantas sessões VIRAM cada bloco da tela de oferta.
//      É a que responde "em que parte da oferta a pessoa desiste".
//   3. QUAL BOTÃO TRABALHA — a tela de resultado tem dois CTAs iguais.

const db = require('./_db');
const { applyCors } = require('./_cors');
const { requireAdmin, periodFilter } = require('./_auth');

// Ordem e rótulo dos degraus. Bate com STEP_INDEX do api/track.js.
const PASSOS = [
  { key: 'visit',          step: 0, label: 'Abriu o quiz' },
  { key: 'quiz_start',     step: 1, label: 'Respondeu a 1ª pergunta' },
  { key: 'quiz_half',      step: 2, label: 'Chegou na 5ª' },
  { key: 'quiz_finish',    step: 3, label: 'Respondeu as 10' },
  { key: 'capture_view',   step: 4, label: 'Viu a tela de contato' },
  { key: 'result_view',    step: 5, label: 'Viu o resultado (a oferta)' },
  { key: 'offer_view',     step: 6, label: 'Rolou até o preço' },
  { key: 'cta_click',      step: 7, label: 'Clicou no botão de compra' },
  { key: 'checkout_click', step: 8, label: 'Foi pro checkout' },
];

module.exports = async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const E = periodFilter(q, 'ts', 1);

  try {
    await db.initDb();

    // ── 1. Funil cumulativo ───────────────────────────────────────────────
    // A pergunta é "quantas sessões chegaram AO MENOS no passo N". Contar
    // sessões distintas agrupando por step_index não responde isso: uma sessão
    // que andou até o checkout emitiu evento em todos os passos, então ela
    // apareceria em nove grupos e o total estouraria.
    //
    // Aqui cada sessão é reduzida ao passo MAIS ALTO que alcançou — uma linha
    // por sessão. Aí sim o acúmulo de trás pra frente fecha: quem terminou no
    // 7 conta no 6, no 5, e assim por diante.
    const funil = await db.query(
      `WITH topo_por_sessao AS (
         SELECT session_id, MAX(step_index) AS topo
           FROM bt_events
          WHERE ${E.clause}
          GROUP BY session_id
       )
       SELECT topo, COUNT(*)::int AS sessoes
         FROM topo_por_sessao
        GROUP BY topo ORDER BY topo`,
      E.params
    );
    const porStep = new Map(funil.rows.map(r => [Number(r.topo), Number(r.sessoes)]));

    let acumulado = 0;
    const maxStep = Math.max(0, ...Array.from(porStep.keys()));
    const cumulativo = new Map();
    for (let i = maxStep; i >= 0; i--) {
      acumulado += porStep.get(i) || 0;
      cumulativo.set(i, acumulado);
    }

    const topo = cumulativo.get(0) || 0;
    const passos = PASSOS.map(p => ({
      ...p,
      sessoes: cumulativo.get(p.step) || 0,
      pct_do_topo: topo ? Number((((cumulativo.get(p.step) || 0) / topo) * 100).toFixed(1)) : 0,
    }));

    // Queda entre passos consecutivos — o maior número aqui é o gargalo.
    for (let i = 1; i < passos.length; i++) {
      const ant = passos[i - 1].sessoes;
      passos[i].perdeu = Math.max(0, ant - passos[i].sessoes);
      passos[i].pct_do_anterior = ant ? Number(((passos[i].sessoes / ant) * 100).toFixed(1)) : 0;
    }

    // ── 2. Alcance por seção da tela de oferta ────────────────────────────
    const secoes = await db.query(
      `SELECT section, COUNT(DISTINCT session_id)::int AS sessoes
         FROM bt_events
        WHERE event_name = 'section_view' AND section IS NOT NULL AND ${E.clause}
        GROUP BY section ORDER BY sessoes DESC`,
      E.params
    );

    // ── 3. Onde as sessões PARARAM dentro da oferta ───────────────────────
    const S = periodFilter(q, 'first_ts', 1);
    const abandono = await db.query(
      `SELECT COALESCE(last_section, 'não registrada') AS section,
              COUNT(*)::int AS sessoes
         FROM bt_sessions
        WHERE ${S.clause} AND reached_result AND NOT reached_checkout
        GROUP BY 1 ORDER BY sessoes DESC LIMIT 20`,
      S.params
    );

    // ── 4. Qual CTA realmente trabalha ────────────────────────────────────
    // A tela de resultado tem o mesmo botão em cima e embaixo do FAQ.
    const ctas = await db.query(
      `SELECT COALESCE(section, '—') AS section,
              COALESCE(label, 'CTA') AS label,
              COUNT(*)::int                   AS cliques,
              COUNT(DISTINCT session_id)::int AS sessoes
         FROM bt_events
        WHERE event_name IN ('cta_click','checkout_click') AND ${E.clause}
        GROUP BY 1,2 ORDER BY cliques DESC LIMIT 30`,
      E.params
    );

    // ── 5. Contato: deixou ou pulou ───────────────────────────────────────
    // A tela de captura é opcional (tem o botão "Pular"). Aqui se vê o preço
    // real de pedir o e-mail antes de mostrar o resultado.
    const captura = await db.query(
      `SELECT event_name, COUNT(DISTINCT session_id)::int AS sessoes
         FROM bt_events
        WHERE event_name IN ('capture_submit','capture_skip') AND ${E.clause}
        GROUP BY 1`,
      E.params
    );

    return res.status(200).json({
      passos,
      secoes:   secoes.rows,
      abandono: abandono.rows,
      ctas:     ctas.rows,
      captura:  captura.rows,
    });
  } catch (err) {
    console.error('admin-funnel:', err.message);
    return res.status(500).json({ error: 'Falha ao montar o funil', detail: err.message });
  }
};
