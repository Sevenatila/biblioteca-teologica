# Painel de monitoramento do quiz

Quiz em `/Quiz/` e painel em `/painel`, no mesmo projeto Vercel. Sem build,
sem framework, sem biblioteca de gráfico.

```
Quiz/index.html        o quiz (instrumentado)
js/track.js            rastreio do visitante
painel/index.html      o painel (SPA, sem build)
api/
  track.js             ingestão pública de eventos, cliques e sessão
  admin-login.js       login → JWT de 8h
  admin-stats.js       Visão Geral
  admin-funnel.js      Funil
  admin-heatmap.js     Mapa de Calor
  admin-quiz.js        Perguntas
  admin-orders.js      Vendas
  admin-sessions.js    Sessões e jornada individual
  admin-events.js      Log cru
  webhook-vega.js      ingestão das vendas (vem do checkout, não do navegador)
  _db.js _cors.js _ratelimit.js _auth.js
db/schema.sql          schema (o _db.js também cria sozinho)
```

## Subir

1. Commitar e dar push — a Vercel faz o resto.
2. Em Settings → Environment Variables, preencher **duas** variáveis:
   `POSTGRES_URL` e `PAINEL_SENHA` (ver `.env.example`). Mais `VEGA_WEBHOOK_TOKEN`
   se quiser a tela de Vendas.
3. Deploy. As tabelas nascem sozinhas na primeira requisição — não precisa
   rodar migration.

`POSTGRES_URL` tem que ser a string do **pooler** (porta 6543 no Supabase).
A conexão direta na 5432 derruba o banco sob carga em ambiente serverless.

O login é só senha, sem usuário. O segredo do JWT é derivado dela quando
`JWT_SECRET` não está definida — é o que permite subir com duas variáveis em
vez de quatro. Trocar a senha invalida as sessões abertas, de brinde.

## As sete telas

| Tela | Responde |
|---|---|
| **Visão Geral** | Quantos abriram, quantos terminaram, quantos viram a oferta, quantos foram pro checkout, quantos compraram. Corte por dia, aparelho e origem. |
| **Funil** | Abriu → 1ª → 5ª → 10ª → contato → resultado → preço → botão → checkout. Marca em vermelho a maior queda. |
| **Mapa de Calor** | A tela de resultado de verdade num iframe, com as manchas de clique por cima. Mais a curva de rolagem, os cliques mortos e o ranking de elementos. |
| **Perguntas** | Que mito mais pega gente, onde largam o quiz, que nota o público tira e se nota baixa converte mais. |
| **Vendas** | Quem comprou (nome, contato, valor, nota que tirou), quem foi ao checkout e não comprou, receita por dia e por origem. |
| **Sessões** | Cada visita, filtrável por comportamento. Clicando, abre a linha do tempo evento a evento. |
| **Eventos** | Log cru. É onde se confere se o rastreio está chegando. |

## Ligar o checkout (tela Vendas)

1. Gere um segredo:
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
2. Ponha em `VEGA_WEBHOOK_TOKEN` nas Environment Variables da Vercel e faça
   redeploy.
3. No checkout, em **Dev → Webhooks**, cadastre:
   `https://SEU-DOMINIO/api/webhook-vega?token=O_MESMO_VALOR`
   marcando os eventos de pedido **pago**, **pendente**, **recusado** e
   **estorno**. A URL pronta, já com o token, fica no rodapé da tela Vendas.

Sem o token configurado o endpoint responde 503 e recusa tudo — de propósito:
um webhook de venda aberto é um convite pra encher seu painel de venda falsa.

**Como a venda cola na visita.** O quiz anexa o id da sessão no link do
checkout em três nomes (`bt_sid`, `sck`, `src`), porque cada gateway devolve
por um. O `api/webhook-vega.js` procura por nome e, se não achar, **por
formato** — o id sempre começa com `bt` seguido de base36, um padrão que não
colide com mais nada no payload. Se ainda assim não vier, a venda entra na
receita normalmente, só fica sem jornada; o painel avisa quantas estão assim.

**Por que o parser é tolerante.** Nenhum campo do payload é obrigatório e cada
um é procurado por vários nomes conhecidos (`amount`, `total`, `valor`,
`total_value`…). O payload cru vai inteiro pra coluna `raw`, então mudança de
formato do gateway não perde dado — dá pra reprocessar. Valor é normalizado
pra **centavos** na entrada; o painel é o único lugar que converte pra real.

Estorno e chargeback saem da receita e desmarcam a compra na sessão. O
`paid_at`, não: ele guarda a primeira aprovação, porque "foi pago um dia" é
fato histórico.

## Por que o mapa de calor é só da última página

O quiz é uma SPA: as 10 perguntas, a tela de contato e o resultado moram todos
em `/Quiz/`, trocando o conteúdo de `#stage`. Um clique a 40% da altura
significa "opção C da pergunta 3" numa tela e "o botão de comprar" na outra —
somar tudo num mapa só daria um borrão sem significado.

Então **clique e rolagem só são gravados na tela de resultado**, que é onde
está a oferta e a decisão de compra. O resto do quiz continua medido por
evento — funil, acerto por pergunta, abandono — que é o que faz sentido lá.

Para o painel conseguir mostrar essa tela dentro de um iframe sem responder 10
perguntas, o quiz aceita `/Quiz/?hm=1&band=2`: abre direto no resultado com uma
nota da faixa escolhida. O `js/track.js` se desliga sozinho nesse modo (está em
iframe **e** tem `hm=1` na URL), então olhar o mapa nunca gera dado falso.

O filtro por **faixa** existe pela mesma razão: as quatro faixas de resultado
mostram títulos e diagnósticos diferentes, e os chips de mito mudam de
quantidade — ou seja, são quatro páginas de alturas diferentes.

## O que é medido

`visit`, `quiz_start`, `quiz_answer` (por pergunta, acerto/erro),
`quiz_half`, `quiz_finish`, `capture_view`, `capture_submit`, `capture_skip`,
`result_view`, `section_view`, `scroll_25/50/75/90`, `offer_view`, `faq_open`,
`cta_click`, `checkout_click`, `rage_click`, `exit`.

Os blocos da tela de resultado são marcados com `data-sec` no HTML. Ao mexer na
página, mantenha esses atributos — senão o painel perde a referência de onde as
coisas acontecem. A ordem deles está em `ORDEM_SECOES`, no `painel/index.html`.

**O e-mail/WhatsApp digitado na tela de contato não é enviado ao rastreio.** Só
registramos que a pessoa preencheu, nunca o que preencheu.

## O que o painel não vê

Com o webhook ligado, o funil vai até a venda. O que continua fora do alcance
daqui é o que acontece **dentro** do checkout: quantos abriram o formulário,
onde travaram no pagamento, quantas tentativas de cartão. Essa parte só o
relatório do próprio gateway mostra.

O e-mail digitado na tela de contato do quiz também não entra aqui — só o do
comprador, que vem do gateway junto com o pedido.

## Não rastrear

- `/Quiz/?notrack=1` na URL, ou `localStorage.setItem('bt_notrack','1')` no console.
- Dentro de iframe o rastreio já se desliga sozinho.
