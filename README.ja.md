# durable-webhook

[![test](https://github.com/lon-coeng/durable-webhook/actions/workflows/test.yml/badge.svg)](https://github.com/lon-coeng/durable-webhook/actions/workflows/test.yml)

*[English version](README.md)*

**すぐ受け取って、諦めずに届ける** Webhook リレーです。Cloudflare Workers 上で動きます。

無料枠で運用できます。実行時の依存はありません。

---

## 何が問題か

Webhook の送信元（LINE、Stripe、GitHub など）は、数秒で `200` が返らないと失敗とみなして再送し、数回で諦めます。一方で転送先のアプリは時々落ちます。デプロイ中の30秒、DB の一時的な不調、運の悪いコールドスタート。

```
送信元 → アプリ（落ちている）
         ↓
       500、あるいは無応答
         ↓
       送信元は数回再送して、諦める
         ↓
       そのイベントは失われる
```

**受け取ること**と**届けること**を1つの動作として扱うのをやめれば解決します。受け取りは必ず成功させ、配送は後回しにして、諦めずに試し続けます。

## 何をするか

```
POST /hook/:id
  ↓  署名を検証（設定されていれば）
  ↓  同じイベントを受け取り済みか → 済みなら 200 を返して終了
  ↓  配送予定を KV へ書く
  ↓  202 を返す                      ← ここまで数十ミリ秒
  ↓
  （バックグラウンドで）配送を試みる
  ↓  失敗したら配送待ちとして残す
  ↓
Cron (5分ごと) が配送待ちを掃き、間隔を広げながら再試行
  ↓  試行を尽くしたら退避へ。捨てはしない
  ↓
GET  /dead-letters/:id                届かなかったものの一覧
POST /dead-letters/:id/:did/replay    もう一度送る
     ↑ この2つは運用者向け。ADMIN_TOKEN が要る
```

## 設計上の判断

**`200` は「受け取った」であって「届けた」ではありません。** ここを混ぜると、転送先が遅いだけで送信元には失敗に見え、避けたかった再送の嵐がそのまま起きます。

**再試行はリクエストの中ではなく Cron に置きます。** Worker には実行時間の上限があり、1回の実行の中で1時間待つことはできません。配送待ちを KV に置き、5分ごとの定期実行が掃きます。

**掃く間隔は KV の無料枠が決めています。** KV の list は1日1,000回までで、**無料枠で最も少ない操作**です（読み取りは100,000回）。1分ごとに回すと訪問者がゼロでも1日1,440回になり、上限を超えた時点でその日の再試行が止まります。1回目の配送は受け取った時点で試すので、ここが遅くても最初の配送は遅れません。

**間隔は 1分 → 5分 → 15分 → 1時間 → 6時間 と広げます。** 等間隔は両方向に間違いです。一瞬の揺れは1分で収まりますし、何時間も続く障害を1分おきに叩く意味はありません。

**すべての失敗が再試行に値するわけではありません。** `4xx` は転送先が内容を見た上で拒んでいるので、同じものを送り直しても結果は変わりません。退避へ直行させます。`408` と `429` だけは例外で、時間を空ければ通ります。

**重複は入口で弾きます。** 送信元は再送してきます。転送先が同じイベントを2回処理すると、誰かが2回課金されます。イベントIDは設定したヘッダから取り、送信元が付けていなければ本文のハッシュで代用します。

**管理系の経路は別の鍵で守ります。** 退避の一覧と再送は運用者が叩くもので、送信元の署名では守れません。特に再送を外から叩かれると、転送先で二重処理が起きます。**このツールが防ぐために作られた事故を、外から起こせることになります。** `ADMIN_TOKEN` が未設定のときは、開くのではなく `503` で止めます。開いていることには誰も気付けませんが、動かないことにはすぐ気付きます。

**何も捨てません。** 試行を尽くした配送は、本文を保ったまま退避へ移します。人間が見て判断できるようにするためです。消してしまうと失敗が見えなくなり、それは失敗そのものより悪い結果です。

## 稼働中

```
https://durable-webhook.lon-coeng.workers.dev
```

`main` に入ったものを GitHub Actions が Cloudflare へ配ります。テストを通ってから配り、配ったあとに実際の応答まで確認します（[deploy.yml](.github/workflows/deploy.yml)）。

`GET /` は生存確認だけを返します。`POST /hook/:id` は署名が要り、退避の一覧と再送は `ADMIN_TOKEN` が要ります。

## 導入

```sh
npm install
npx wrangler kv namespace create WEBHOOKS   # 出た id を wrangler.toml へ
npx wrangler secret put ENDPOINTS
npx wrangler secret put ADMIN_TOKEN         # 退避の一覧と再送に使う
npx wrangler deploy
```

`ENDPOINTS` は JSON です。転送先の URL と署名の鍵を含むので、`wrangler.toml` ではなく Secret に置きます。

```json
[
  {
    "id": "github",
    "targetUrl": "https://app.example.com/webhooks/github",
    "secret": "共有シークレット",
    "signatureHeader": "x-hub-signature-256",
    "idHeaders": ["x-github-delivery"]
  },
  {
    "id": "internal",
    "targetUrl": "https://app.example.com/webhooks/internal",
    "headers": { "authorization": "Bearer ..." }
  }
]
```

送信元の宛先を `https://<worker名>.workers.dev/hook/github` にします。

## 試す

```sh
npx wrangler dev

curl -X POST http://localhost:8787/hook/demo \
  -H 'content-type: application/json' \
  -H 'x-request-id: evt_1' \
  -d '{"hello":"world"}'
# {"status":"accepted","deliveryId":"...","eventId":"evt_1"}

# 同じイベントIDでもう一度
curl -X POST http://localhost:8787/hook/demo \
  -H 'x-request-id: evt_1' -d '{"hello":"world"}'
# {"status":"duplicate","eventId":"evt_1"}

# 退避の一覧。ADMIN_TOKEN が要る
curl http://localhost:8787/dead-letters/demo \
  -H 'authorization: Bearer <ADMIN_TOKEN>'
```

`targetUrl` を 500 を返す先に向ければ、再試行から退避まで一通り確認できます。

## やらないこと

**順序は保証しません。** 配送は互いに独立しています。順序を守るには Durable Objects が要りますが、今回解こうとしたのは順序の問題ではありません。

**複数の転送先へは送りません。** 1つのエンドポイントに1つの転送先です。複数にすると再試行の状態を転送先ごとに持つ必要があり、複雑さに見合いません。

**キューではありません。** この用途には Cloudflare Queues の方が適していて、実装も簡単になります。ただし有料プランが要ります。KV と Cron なら無料枠に収まります。規模が出るなら Queues へ移すべきです。

## テスト

```sh
npm test
```

インストールは不要です。Node の組み込みだけで動きます。検査しているのは外部サービスに触れない部分——バックオフの計算、配送の状態遷移、定数時間比較を含む署名検証、イベントの同一性判定、設定の検証です。`fetch` はスタブに差し替えています。ネットワークがどう振る舞うかは Cloudflare の責任範囲で、ここで検査しても得るものがありません。

## ライセンス

MIT. [LICENSE](LICENSE) を参照してください。
