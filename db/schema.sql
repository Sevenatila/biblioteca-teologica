-- ============================================================================
-- Biblioteca Teológica — schema do painel de monitoramento do quiz
-- ============================================================================
-- Roda sozinho na primeira requisição (api/_db.js chama initDb), mas fica aqui
-- pra você poder aplicar na mão no SQL Editor do Supabase se preferir.
--
-- Desenho: 3 tabelas quentes (eventos, cliques, sessões) + 1 de rate limit.
-- As quentes têm autolimpeza por data — o painel só olha os últimos 30 dias.
-- ============================================================================

-- ── EVENTOS DO FUNIL ────────────────────────────────────────────────────────
-- 1 linha por evento. Base do funil, do gráfico de blocos e do log cru.
CREATE TABLE IF NOT EXISTS bt_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  VARCHAR(40)  NOT NULL,
  event_name  VARCHAR(60)  NOT NULL,
  step_index  SMALLINT     NOT NULL DEFAULT 0,  -- ordem no funil (funil cumulativo)
  section     VARCHAR(40),                      -- q1..q10 no quiz; data-sec na oferta
  label       VARCHAR(120),                     -- hit/miss, texto do botão, tema do mito
  device      VARCHAR(10),                      -- mobile | tablet | desktop
  ts          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bt_events_ts      ON bt_events (ts);
CREATE INDEX IF NOT EXISTS idx_bt_events_session ON bt_events (session_id);
CREATE INDEX IF NOT EXISTS idx_bt_events_name_ts ON bt_events (event_name, ts);

-- ── CLIQUES (MAPA DE CALOR) ─────────────────────────────────────────────────
-- Só grava clique da TELA DE RESULTADO — a última página do quiz. O quiz é uma
-- SPA: perguntas, captura e resultado moram na mesma URL com alturas e
-- conteúdos diferentes, então y_pct de telas distintas não se compara.
--
-- x_pct/y_pct são PERCENTUAIS (0..1), não pixels: é o que faz o mapa continuar
-- certo entre um iPhone SE e um desktop 1440p.
--   x_pct   → relativo à LARGURA da viewport
--   y_pct   → relativo à ALTURA TOTAL do documento
--   sec_pct → posição dentro do próprio bloco (0..1)
--   band    → faixa do resultado (1..4); a página muda por faixa, o mapa também
CREATE TABLE IF NOT EXISTS bt_clicks (
  id          BIGSERIAL PRIMARY KEY,
  session_id  VARCHAR(40) NOT NULL,
  section     VARCHAR(40),
  label       VARCHAR(120),
  x_pct       REAL        NOT NULL,
  y_pct       REAL        NOT NULL,
  sec_pct     REAL,
  is_cta      BOOLEAN     NOT NULL DEFAULT FALSE, -- caiu no botão de compra?
  dead        BOOLEAN     NOT NULL DEFAULT FALSE, -- clique em área sem ação
  device      VARCHAR(10),
  band        SMALLINT,
  vw          SMALLINT,
  vh          SMALLINT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bt_clicks_ts      ON bt_clicks (ts);
CREATE INDEX IF NOT EXISTS idx_bt_clicks_section ON bt_clicks (section, ts);

-- ── SESSÕES ─────────────────────────────────────────────────────────────────
-- 1 linha por visita, atualizada por UPSERT ao longo do quiz.
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
  last_section  VARCHAR(40),                       -- último bloco da oferta visto
  duration_sec  INTEGER     NOT NULL DEFAULT 0,   -- tempo ATIVO (aba em foco)
  cta_clicks    SMALLINT    NOT NULL DEFAULT 0,
  reached_checkout BOOLEAN  NOT NULL DEFAULT FALSE,
  -- Espelho da venda, carimbado pelo webhook do gateway. Fica aqui (e não só
  -- em bt_orders) pra cruzar compra com nota, faixa e origem sem JOIN.
  purchased      BOOLEAN    NOT NULL DEFAULT FALSE,
  purchase_cents INTEGER,
  purchase_ts    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bt_sessions_first ON bt_sessions (first_ts);
CREATE INDEX IF NOT EXISTS idx_bt_sessions_utm   ON bt_sessions (utm_source, utm_campaign);

-- Quem já tinha o painel no ar antes da tela de Vendas: as três colunas acima
-- nascem por aqui (o api/_db.js roda estes ALTERs sozinho a cada deploy).
ALTER TABLE bt_sessions ADD COLUMN IF NOT EXISTS purchased      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bt_sessions ADD COLUMN IF NOT EXISTS purchase_cents INTEGER;
ALTER TABLE bt_sessions ADD COLUMN IF NOT EXISTS purchase_ts    TIMESTAMPTZ;

-- ── VENDAS ──────────────────────────────────────────────────────────────────
-- 1 linha por pedido, alimentada pelo webhook do checkout (api/webhook-vega.js).
-- É a única tabela que sabe o que acontece DEPOIS do clique em comprar.
--
-- order_id é UNIQUE de propósito: o webhook chega repetido e chega em ordem
-- (pendente → pago → estornado). O insert é upsert — reenvio não duplica venda.
-- `raw` guarda o payload cru: se o gateway mudar um nome de campo, nada se perde.
--
-- Esta tabela NÃO tem autolimpeza por data, ao contrário das outras três.
CREATE TABLE IF NOT EXISTS bt_orders (
  id            BIGSERIAL PRIMARY KEY,
  order_id      VARCHAR(120) NOT NULL UNIQUE,  -- id do pedido no gateway
  session_id    VARCHAR(40),                   -- visita que originou (NULL se não veio)
  status        VARCHAR(20)  NOT NULL,         -- pago|pendente|recusado|estornado|chargeback|cancelado|abandonado|desconhecido
  evento        VARCHAR(60),                   -- nome do evento no webhook
  valor_cents   INTEGER,                       -- SEMPRE em centavos
  moeda         VARCHAR(3)   NOT NULL DEFAULT 'BRL',
  metodo        VARCHAR(20),                   -- pix|cartao|boleto|...
  produto       VARCHAR(160),
  cliente_nome  VARCHAR(160),
  cliente_email VARCHAR(160),
  cliente_fone  VARCHAR(40),
  utm_source    VARCHAR(120),
  utm_campaign  VARCHAR(160),
  raw           JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- 1ª notificação
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- última notificação
  paid_at       TIMESTAMPTZ                           -- quando virou pago
);
CREATE INDEX IF NOT EXISTS idx_bt_orders_created ON bt_orders (created_at);
CREATE INDEX IF NOT EXISTS idx_bt_orders_status  ON bt_orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_bt_orders_session ON bt_orders (session_id);

-- ── RATE LIMIT ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bt_rate_limit (
  key    VARCHAR(160) NOT NULL,
  ts     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bt_rate_limit ON bt_rate_limit (key, ts);
