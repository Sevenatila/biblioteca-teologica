// api/_db.js
// Pool Postgres compartilhado + criação das tabelas sob demanda.
//
// Conexão: process.env.POSTGRES_URL. Serve Supabase, Neon, Vercel Postgres —
// é só uma URL Postgres. No Supabase use a string do POOLER (porta 6543), não
// a direta (5432): serverless abre e fecha conexão o tempo todo e a direta
// estoura o limite do banco.
//
// As tabelas nascem sozinhas na primeira requisição — não precisa rodar
// migration nenhuma pra subir o painel.

const { Pool } = require('pg');

let connectionString = process.env.POSTGRES_URL;

if (connectionString) {
  try {
    // Tira o sslmode da URL pra opção ssl do Pool valer (senão ela é ignorada)
    const parsed = new URL(connectionString);
    parsed.searchParams.delete('sslmode');
    connectionString = parsed.toString();
  } catch (err) {
    console.error('POSTGRES_URL malformada:', err.message);
  }
} else {
  console.warn('POSTGRES_URL não definida — as rotas de dados vão responder vazio.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  // Cada invocação serverless tem seu próprio Pool e roda as queries em série:
  // 1 conexão basta. idle curto + allowExitOnIdle devolvem a conexão rápido,
  // que é o que impede o "max client connections reached" numa rajada.
  max: 1,
  idleTimeoutMillis: 8000,
  connectionTimeoutMillis: 20000,
  allowExitOnIdle: true,
});

let initialized = false;

async function initDb() {
  if (initialized) return;
  const c = await pool.connect();
  try {
    // ── EVENTOS DO FUNIL ────────────────────────────────────────────────────
    // 1 linha por evento. Base do funil, do gráfico de seções e do log cru.
    await c.query(`
      CREATE TABLE IF NOT EXISTS bt_events (
        id          BIGSERIAL PRIMARY KEY,
        session_id  VARCHAR(40)  NOT NULL,
        event_name  VARCHAR(60)  NOT NULL,
        step_index  SMALLINT     NOT NULL DEFAULT 0,
        section     VARCHAR(40),
        label       VARCHAR(120),
        device      VARCHAR(10),
        ts          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_events_ts ON bt_events (ts);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_events_session ON bt_events (session_id);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_events_name_ts ON bt_events (event_name, ts);`);

    // ── CLIQUES (MAPA DE CALOR) ─────────────────────────────────────────────
    // Só grava clique da TELA DE RESULTADO — ver js/track.js. O quiz é uma SPA:
    // as 10 perguntas, a captura e o resultado moram na mesma URL, com alturas
    // e conteúdos completamente diferentes. Misturar tudo num mapa só daria um
    // borrão sem significado, porque y_pct de telas distintas não se compara.
    //
    // x_pct/y_pct são PERCENTUAIS (0..1), não pixels — é isso que faz o mapa
    // continuar certo entre um iPhone SE e um desktop 1440p.
    //   x_pct → relativo à LARGURA da viewport
    //   y_pct → relativo à ALTURA TOTAL do documento
    //   sec_pct → posição dentro da própria seção (0..1)
    await c.query(`
      CREATE TABLE IF NOT EXISTS bt_clicks (
        id          BIGSERIAL PRIMARY KEY,
        session_id  VARCHAR(40) NOT NULL,
        section     VARCHAR(40),
        label       VARCHAR(120),
        x_pct       REAL        NOT NULL,
        y_pct       REAL        NOT NULL,
        sec_pct     REAL,
        is_cta      BOOLEAN     NOT NULL DEFAULT FALSE,
        dead        BOOLEAN     NOT NULL DEFAULT FALSE,
        device      VARCHAR(10),
        band        SMALLINT,
        vw          SMALLINT,
        vh          SMALLINT,
        ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_clicks_ts ON bt_clicks (ts);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_clicks_section ON bt_clicks (section, ts);`);

    // ── SESSÕES ─────────────────────────────────────────────────────────────
    // 1 linha por visita, atualizada por UPSERT ao longo do quiz. Daqui saem
    // tempo, até que pergunta foi, nota, faixa de resultado, rolagem na tela
    // de oferta e origem do tráfego.
    await c.query(`
      CREATE TABLE IF NOT EXISTS bt_sessions (
        session_id    VARCHAR(40) PRIMARY KEY,
        first_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        device        VARCHAR(10),
        vw            SMALLINT,
        referrer      TEXT,
        landing_path  VARCHAR(200),
        utm_source    VARCHAR(120),
        utm_medium    VARCHAR(120),
        utm_campaign  VARCHAR(160),
        utm_content   VARCHAR(160),
        utm_term      VARCHAR(160),
        fbclid        VARCHAR(255),
        country       VARCHAR(2),
        max_q         SMALLINT    NOT NULL DEFAULT 0,   -- até que pergunta respondeu (0..10)
        score         SMALLINT,                          -- nota final; NULL = não terminou
        band          SMALLINT,                          -- faixa do resultado (1..4)
        contact       BOOLEAN     NOT NULL DEFAULT FALSE,-- deixou e-mail/WhatsApp
        reached_result BOOLEAN    NOT NULL DEFAULT FALSE,
        max_scroll    SMALLINT    NOT NULL DEFAULT 0,   -- 0..100, SÓ na tela de resultado
        last_section  VARCHAR(40),                       -- última seção da oferta vista
        duration_sec  INTEGER     NOT NULL DEFAULT 0,   -- tempo ATIVO (aba em foco)
        cta_clicks    SMALLINT    NOT NULL DEFAULT 0,
        reached_checkout BOOLEAN  NOT NULL DEFAULT FALSE
      );`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_sessions_first ON bt_sessions (first_ts);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_sessions_utm ON bt_sessions (utm_source, utm_campaign);`);

    // ── RATE LIMIT ──────────────────────────────────────────────────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS bt_rate_limit (
        key VARCHAR(160) NOT NULL,
        ts  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_bt_rate_limit ON bt_rate_limit (key, ts);`);

    initialized = true;
  } finally {
    c.release();
  }
}

async function query(text, params) {
  if (!connectionString) throw new Error('POSTGRES_URL não configurada');
  return pool.query(text, params);
}

module.exports = { pool, query, initDb, hasDb: !!connectionString };
