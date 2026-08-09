/*!
 * Biblioteca Teológica — rastreio do quiz
 * ---------------------------------------------------------------------------
 * Alimenta o /painel. Regras que este arquivo se impõe:
 *
 *  1. NUNCA atrapalhar o quiz. Tudo em try/catch, tudo passivo, zero
 *     dependência. Se este script explodir, o quiz continua vendendo.
 *  2. Mandar em LOTE. Um sendBeacon a cada 5s ou 15 eventos — não um por
 *     clique. Beacon sobrevive ao fechamento da aba.
 *  3. Nada de dado pessoal. O e-mail/WhatsApp digitado na captura NÃO sai
 *     daqui: só registramos que a pessoa preencheu, nunca o que preencheu.
 *
 * ── O detalhe que rege o mapa de calor ──────────────────────────────────────
 * O quiz é uma SPA: as 10 perguntas, a tela de contato e o resultado moram
 * todos em /Quiz/, trocando o conteúdo de #stage. Coordenada de clique só faz
 * sentido comparada dentro da MESMA tela — somar o clique da pergunta 3 com o
 * clique no botão de compra daria um borrão sem significado.
 *
 * Por isso CLIQUE e ROLAGEM só são gravados quando `fase === 'resultado'`,
 * a última página. O resto do quiz continua sendo medido por evento (funil,
 * acerto por pergunta, abandono), que é o que faz sentido lá.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/track';
  var FLUSH_MS = 5000;
  var FLUSH_AT = 15;

  // ── Não rastrear dentro de iframe ─────────────────────────────────────────
  // O /painel abre o quiz num iframe pra desenhar o mapa de calor. Sem esta
  // guarda, cada vez que você olhasse o mapa criaria visita e clique falsos —
  // o painel medindo a si mesmo.
  try { if (window.self !== window.top) return; } catch (_) { return; }

  // Escapes manuais pra depurar sem sujar os dados.
  try {
    if (/[?&](notrack=1|hm=1)/.test(location.search)) return;
    if (localStorage.getItem('bt_notrack') === '1') return;
  } catch (_) {}

  // ── Sessão ────────────────────────────────────────────────────────────────
  // sessionStorage: mesma aba = mesma sessão. Fechou a aba, começa outra — que
  // é exatamente o comportamento que se quer medir num quiz.
  var sid;
  function novoId() {
    return 'bt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  try {
    sid = sessionStorage.getItem('bt_sid');
    if (!sid) { sid = novoId(); sessionStorage.setItem('bt_sid', sid); }
  } catch (_) { sid = novoId(); }

  var vw = window.innerWidth || document.documentElement.clientWidth;
  var device = vw < 768 ? 'mobile' : (vw < 1024 ? 'tablet' : 'desktop');

  // ── Origem do tráfego ─────────────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var utm = {
    utm_source:   params.get('utm_source'),
    utm_medium:   params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    utm_content:  params.get('utm_content'),
    utm_term:     params.get('utm_term'),
    fbclid:       params.get('fbclid'),
  };

  // ── Estado ────────────────────────────────────────────────────────────────
  var fila = { events: [], clicks: [] };
  var fase = 'quiz';        // quiz | captura | resultado
  var maxQ = 0;             // última pergunta respondida
  var score = null;
  var band = null;
  var contato = false;
  var chegouResultado = false;
  var maxScroll = 0;        // rolagem NA TELA DE RESULTADO
  var lastSection = null;
  var ctaClicks = 0;
  var foiCheckout = false;
  var marcos = {};          // scroll_25/50/75/90 já disparados
  var secoesVistas = {};    // section_view já disparado por seção
  var ativoSeg = 0;         // tempo ATIVO (aba visível), em segundos
  var timerAtivo = null;
  var io = null;

  // Coordenada é percentual: fora de 0..1 não existe. O servidor também limita,
  // mas quem manda o dado é que tem contexto pra não mandar lixo.
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function evento(name, section, label) {
    fila.events.push({ name: name, section: section || null, label: label || null });
    if (fila.events.length + fila.clicks.length >= FLUSH_AT) enviar(false);
  }

  // ── Envio ─────────────────────────────────────────────────────────────────
  function corpo() {
    return JSON.stringify({
      sessionId: sid,
      device: device,
      events: fila.events,
      clicks: fila.clicks,
      session: {
        vw: vw,
        referrer: document.referrer || null,
        path: location.pathname,
        utm_source: utm.utm_source, utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign, utm_content: utm.utm_content,
        utm_term: utm.utm_term, fbclid: utm.fbclid,
        maxQ: maxQ,
        score: score,
        band: band,
        contact: contato,
        reachedResult: chegouResultado,
        maxScroll: maxScroll,
        lastSection: lastSection,
        duration: ativoSeg,
        ctaClicks: ctaClicks,
        reachedCheckout: foiCheckout,
      },
    });
  }

  function enviar(saindo) {
    if (!fila.events.length && !fila.clicks.length && !saindo) return;
    var payload = corpo();
    fila = { events: [], clicks: [] };
    try {
      // Beacon sobrevive ao fechamento da aba; fetch não (por isso o fallback
      // usa keepalive, que é o equivalente possível).
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(ENDPOINT, {
          method: 'POST', body: payload, keepalive: true,
          headers: { 'Content-Type': 'application/json' },
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // ── Tempo ativo ───────────────────────────────────────────────────────────
  // Aba em segundo plano não conta. Sem isso, "tempo médio" vira ficção: uma
  // aba esquecida aberta por 40 min viraria engajamento.
  function ligarRelogio() {
    if (timerAtivo) return;
    timerAtivo = setInterval(function () { if (!document.hidden) ativoSeg++; }, 1000);
  }

  // ── Seções da tela de resultado ───────────────────────────────────────────
  // Cada bloco marcado com data-sec no HTML da oferta. Só entra em ação quando
  // o resultado é montado — antes disso não existe seção nenhuma na página.
  function observarSecoes() {
    if (io) { io.disconnect(); io = null; }
    var alvos = document.querySelectorAll('[data-sec]');
    if (!alvos.length) return;

    if (!('IntersectionObserver' in window)) {
      lastSection = alvos[0].getAttribute('data-sec');
      return;
    }
    io = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (!e.isIntersecting) return;
        var nome = e.target.getAttribute('data-sec');
        if (!nome) return;
        lastSection = nome;
        if (!secoesVistas[nome]) {
          secoesVistas[nome] = 1;
          evento('section_view', nome);
          // Chegar no bloco de preço é um degrau do funil, não só engajamento:
          // é o momento em que a oferta de fato apareceu na tela.
          if (nome === 'preco') evento('offer_view', nome);
        }
      });
    }, { threshold: 0.35 });   // 35% visível = "viu de verdade"
    Array.prototype.forEach.call(alvos, function (el) { io.observe(el); });
  }

  function secaoDe(el) {
    var n = el;
    while (n && n !== document.body) {
      if (n.getAttribute && n.getAttribute('data-sec')) return n.getAttribute('data-sec');
      n = n.parentElement;
    }
    return lastSection;
  }

  // ── Rolagem (só no resultado) ─────────────────────────────────────────────
  var tickScroll = false;
  function aoRolar() {
    if (fase !== 'resultado' || tickScroll) return;
    tickScroll = true;
    requestAnimationFrame(function () {
      tickScroll = false;
      var doc = document.documentElement;
      var altura = Math.max(doc.scrollHeight, document.body.scrollHeight) - window.innerHeight;
      if (altura <= 0) return;
      var pct = Math.round((window.scrollY / altura) * 100);
      if (pct > maxScroll) maxScroll = Math.min(100, pct);

      [25, 50, 75, 90].forEach(function (m) {
        if (maxScroll >= m && !marcos[m]) {
          marcos[m] = 1;
          evento('scroll_' + m, lastSection);
        }
      });
    });
  }

  // ── Cliques ───────────────────────────────────────────────────────────────
  function rotulo(el) {
    if (!el) return null;
    var t = (el.getAttribute && (el.getAttribute('data-track') || el.getAttribute('aria-label'))) || '';
    if (!t && el.tagName === 'IMG') t = el.getAttribute('alt') || 'imagem';
    if (!t) t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!t) t = el.tagName.toLowerCase();
    return t.slice(0, 120);
  }

  function acionavel(el) {
    var n = el;
    while (n && n !== document.body) {
      var tag = n.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SUMMARY' ||
          tag === 'SELECT' || tag === 'TEXTAREA') return n;
      if (n.getAttribute && (n.getAttribute('role') === 'button' || n.hasAttribute('onclick'))) return n;
      n = n.parentElement;
    }
    return null;
  }

  var ultimoClique = { x: 0, y: 0, t: 0, n: 0 };

  function aoClicar(e) {
    try {
      var alvo = e.target;
      var acao = acionavel(alvo);
      var ehCheckout = !!(acao && acao.classList && acao.classList.contains('btn-checkout'));

      // Fora do resultado só interessa o clique que MUDA de degrau — o resto
      // (responder pergunta, avançar) o próprio quiz reporta com contexto.
      if (fase !== 'resultado') {
        if (ehCheckout) { foiCheckout = true; ctaClicks++; evento('checkout_click', null, rotulo(acao)); enviar(true); }
        return;
      }

      var doc = document.documentElement;
      // O piso de innerHeight é cinto de segurança: se scrollHeight vier 0 (DOM
      // ainda sem layout, navegador exótico), sem ele a divisão jogaria todo
      // clique pro rodapé da página e o mapa mentiria.
      var alturaDoc = Math.max(doc.scrollHeight, document.body.scrollHeight, window.innerHeight, 1);
      var x = clamp01(e.clientX / (window.innerWidth || 1));
      var y = clamp01(e.pageY / alturaDoc);

      var section = secaoDe(alvo);
      var lab = rotulo(acao || alvo);

      // Posição dentro da própria seção — serve pro heatmap por seção, que
      // continua valendo mesmo se a página mudar de tamanho depois.
      var secPct = null;
      var secEl = alvo.closest ? alvo.closest('[data-sec]') : null;
      if (secEl) {
        var r = secEl.getBoundingClientRect();
        if (r.height > 0) secPct = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      }

      fila.clicks.push({
        section: section, label: lab,
        x: x, y: y, secPct: secPct,
        isCta: ehCheckout,
        dead: !acao,
        band: band,
        vw: window.innerWidth, vh: window.innerHeight,
      });

      if (ehCheckout) {
        foiCheckout = true;
        ctaClicks++;
        evento('cta_click', section, lab);
        evento('checkout_click', section, lab);
        enviar(true);              // sai da página agora — despacha já
      } else if (acao && acao.tagName === 'SUMMARY') {
        evento('faq_open', section, lab);
      }

      // ── Rage click ────────────────────────────────────────────────────────
      // 3 cliques em até 1s dentro de 30px = a pessoa achou que aquilo era
      // botão e não era, ou travou. Vale ouro pra achar atrito na oferta.
      var agora = Date.now();
      var perto = Math.abs(e.clientX - ultimoClique.x) < 30 && Math.abs(e.clientY - ultimoClique.y) < 30;
      if (perto && agora - ultimoClique.t < 1000) {
        ultimoClique.n++;
        if (ultimoClique.n === 3) evento('rage_click', section, lab);
      } else {
        ultimoClique.n = 1;
      }
      ultimoClique.x = e.clientX; ultimoClique.y = e.clientY; ultimoClique.t = agora;

      if (fila.clicks.length >= FLUSH_AT) enviar(false);
    } catch (_) {}
  }

  // ── API que o quiz chama ──────────────────────────────────────────────────
  // Chamadas SEMPRE opcionais: o Quiz usa `window.BT && BT.x()`, então se este
  // arquivo não carregar (bloqueador, rede ruim) o quiz não nota diferença.
  window.BT = {
    // O id desta visita. O quiz anexa ele na URL do checkout pra que o webhook
    // do gateway consiga devolver a venda pra ESTA sessão — é o que fecha o
    // funil até a compra em vez de parar em "foi pro checkout".
    sid: sid,
    // resposta a uma pergunta: n = 1..10, acertou = boolean, tag = tema
    resposta: function (n, acertou, tag) {
      try {
        maxQ = Math.max(maxQ, n);
        if (n === 1)  evento('quiz_start');
        if (n === 5)  evento('quiz_half');
        if (n === 10) evento('quiz_finish');
        evento('quiz_answer', 'q' + n, acertou ? 'hit' : 'miss');
        if (tag) evento('quiz_answer', 'q' + n, String(tag).slice(0, 120));
      } catch (_) {}
    },
    // tela "onde enviamos sua análise"
    captura: function () {
      try { fase = 'captura'; evento('capture_view'); } catch (_) {}
    },
    // preencheu (true) ou pulou (false) — o conteúdo digitado nunca sai daqui
    contato: function (preencheu) {
      try {
        contato = !!preencheu;
        evento(preencheu ? 'capture_submit' : 'capture_skip');
      } catch (_) {}
    },
    // A ÚLTIMA PÁGINA. É daqui pra frente que clique e rolagem contam.
    resultado: function (nota, faixa) {
      try {
        fase = 'resultado';
        chegouResultado = true;
        score = nota;
        band = faixa;
        maxScroll = 0; marcos = {}; secoesVistas = {}; lastSection = null;
        evento('result_view', null, 'nota ' + nota);
        // o DOM da oferta acabou de ser montado — só agora há seção pra observar
        setTimeout(function () { observarSecoes(); aoRolar(); }, 60);
        enviar(false);
      } catch (_) {}
    },
  };

  // ── Partida ───────────────────────────────────────────────────────────────
  function iniciar() {
    try {
      evento('visit', null, location.pathname);
      ligarRelogio();

      window.addEventListener('scroll', aoRolar, { passive: true });
      document.addEventListener('click', aoClicar, { passive: true, capture: true });

      setInterval(function () { enviar(false); }, FLUSH_MS);

      // pagehide cobre o iOS, onde unload não dispara de forma confiável
      window.addEventListener('pagehide', function () { evento('exit', lastSection); enviar(true); });
      document.addEventListener('visibilitychange', function () { if (document.hidden) enviar(true); });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
