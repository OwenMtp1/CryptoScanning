# Audit initial & vérification de l'API Coinbase

Date : 2026-09-25 · Statut : **Étape 0, avant toute implémentation**

## 1. Audit de l'environnement de développement

| Élément | Constat |
|---|---|
| Dépôt | `CryptoScanning`, vide (aucun commit). Branche `claude/coinbase-trading-radar-xbpo4i` |
| Node.js | v22.22.2 (LTS) ✅ |
| Gestionnaires de paquets | npm 10.9.7, pnpm 10.33.0, yarn 1.22.22, bun 1.3.11 |
| PostgreSQL | client psql 16.13 disponible (inutile en V1, voir §4) |
| Docker | 29.3.1 |
| Machine | Linux x86_64, 4 vCPU, 15 Go RAM |
| Registre npm | accessible ✅ |
| GitHub | accessible ✅ |
| `api.coinbase.com` | ❌ **bloqué** par le proxy réseau de l'environnement cloud (HTTP 403 au CONNECT) |
| `advanced-trade-ws.coinbase.com` | ❌ **bloqué** |
| `docs.cdp.coinbase.com` | ❌ **bloqué** (lecture directe impossible) |

**Conséquence :** depuis cet environnement cloud, je ne peux ni lire directement la
documentation officielle ni tester la connexion réelle à Coinbase. Sur ta machine
locale (cible de la V1), ces hôtes seront normalement joignables.

## 2. Méthode de vérification utilisée

La documentation n'étant pas lisible directement, j'ai utilisé deux sources, par
ordre de fiabilité :

1. **Code source du SDK officiel Coinbase** `coinbase/coinbase-advanced-py`
   v1.8.4 (publié le 2026-06-19, dépôt GitHub de l'organisation `coinbase`), plus les
   SDK TypeScript d'exemple `coinbase-samples/advanced-sdk-ts` (dernier commit le 2026-06-02).
   → Fiabilité **élevée** pour les URL, endpoints, noms de canaux et champs.
2. **Extraits indexés de docs.cdp.coinbase.com / help.coinbase.com** via la recherche web.
   → Fiabilité **moyenne** : ce sont des résumés, pas le texte intégral. À revérifier.

Légende : ✅ confirmé par le SDK officiel · 🟡 extrait de doc officielle (à revérifier) · ❓ non vérifié / ambigu

## 3. Résultats

### 3.1 URL de base
- ✅ REST : `https://api.coinbase.com/api/v3/brokerage`
- ✅ WebSocket données de marché : `wss://advanced-trade-ws.coinbase.com`
- ✅ WebSocket données utilisateur : `wss://advanced-trade-ws-user.coinbase.com` (JWT requis)

### 3.2 Endpoints REST publics (sans authentification)
✅ Suffisants pour la phase 1 (Radar) :
- `GET /time`
- `GET /market/products` (paramètres : `limit`, `offset`, `product_type`, `product_ids`, `get_all_products`, …)
- `GET /market/products/{product_id}`
- `GET /market/product_book` (carnet d'ordres, paramètre `aggregation_price_increment`)
- `GET /market/products/{product_id}/candles` (historique, utile pour la baseline et le backtest)
- `GET /market/products/{product_id}/ticker` (derniers trades + meilleur bid/ask)

✅ Champs produit disponibles, entre autres : `product_id`, `price`, `price_percentage_change_24h`,
`volume_24h`, `approximate_quote_24h_volume`, `base_min_size`, `quote_min_size`,
`base_increment`, `quote_increment`, `price_increment`, `status`, `trading_disabled`,
`is_disabled`, `cancel_only`, `limit_only`, `post_only`, `auction_mode`, `view_only`,
`product_type` (SPOT/FUTURE), `quote_currency_id`, `base_currency_id`, `alias`, `alias_to`.

### 3.3 Endpoints authentifiés (pour les étapes suivantes, pas la phase 1)
✅ `GET /products` accepte **`get_tradability_status`** (le public ne le propose pas).
C'est le seul moyen officiel identifié pour savoir si un produit est **tradable pour
ton compte / ta région**. En phase 1 (public), on filtre seulement sur
`status`, `trading_disabled`, `is_disabled`, `cancel_only`, `view_only` et `product_type=SPOT`.

✅ Autres endpoints : `GET /best_bid_ask`, `GET /product_book`, `GET /accounts`,
`GET /portfolios`, `GET /portfolios/{uuid}` (breakdown), `GET /transaction_summary`
(**frais réels du compte** : palier maker/taker), `POST /orders`, `POST /orders/preview`,
`POST /orders/batch_cancel`, `GET /orders/historical/{id}`, `GET /orders/historical/batch`,
`GET /orders/historical/fills`, `GET /key_permissions`.

✅ `GET /key_permissions` renvoie `can_view`, `can_trade`, `can_transfer`,
`portfolio_uuid`, `portfolio_type`. → Le dashboard pourra **vérifier et afficher les
permissions réelles de la clé**, et le bot pourra **refuser de démarrer si
`can_transfer = true`**.

### 3.4 Authentification
- ✅ Clés CDP (Coinbase Developer Platform), nom de la forme `organizations/{org_id}/apiKeys/{key_id}`.
- ✅ JWT signé par requête. **Ed25519 (`EdDSA`) est le type de clé recommandé**
  (ECDSA `ES256` toujours accepté). Faisable avec `node:crypto`, sans SDK tiers.
- 🟡 Le JWT expire après 2 minutes et doit donc être régénéré.

### 3.5 Permissions & portefeuille dédié
- 🟡 Chaque clé API est **rattachée à un seul portfolio**. Elle ne voit et ne crée que
  des données de ce portfolio. Le portfolio est déduit de la clé.
- 🟡 Les niveaux de permission sont View / Trade / Transfer (et un niveau Receive est mentionné).
- **Conclusion :** ce que tu demandes (clé limitée à un portefeuille dédié, sans
  permission de transfert) **semble possible**. Configuration recommandée pour plus tard :
  portfolio « Bot » dédié, clé *View + Trade*, **jamais Transfer**. En phase 1,
  **aucune clé n'est nécessaire**.

### 3.6 WebSocket
- ✅ Canaux : `heartbeats`, `candles`, `market_trades`, `status`, `ticker`,
  `ticker_batch`, `level2`, `user`, `futures_balance_summary`.
- ✅ Seuls `user` et `futures_balance_summary` exigent un JWT. Les canaux de marché
  sont accessibles **sans authentification**.
- ✅ Message d'abonnement : `{"type":"subscribe","product_ids":[...],"channel":"ticker"}`
  (**un canal par message**).
- 🟡 La plupart des canaux se ferment après 60 à 90 s sans mise à jour. Il faut donc
  s'abonner à `heartbeats` pour garder la connexion ouverte. `heartbeat_counter` sert à
  détecter les messages perdus (utile pour la fraîcheur des données dans le Risk Engine).
- 🟡 `level2` garantit la livraison (`snapshot` puis `update`).

### 3.7 Limites de débit
- 🟡 REST, selon un extrait récent : public 3 req/s (6 en rafale), privé 5 req/s
  (10 en rafale). ❓ D'anciennes versions de la doc indiquaient 10 req/s en public et
  30 req/s en privé (souvenir non vérifié) → **ambigu, voir §5**.
- 🟡 WebSocket : 750 connexions/s par IP ; 8 messages non authentifiés/s par IP.
- ✅ Les réponses REST exposent `x-ratelimit-limit`, `x-ratelimit-remaining` et
  `x-ratelimit-reset`. Le client lira ces en-têtes au lieu de coder les limites en dur.

### 3.8 Frais
- 🟡 Modèle maker/taker avec paliers selon le volume sur 30 jours, recalculés chaque heure.
  Les paliers ont été modifiés en septembre 2026. 0 % maker sur certaines paires stables.
- **Décision :** ne jamais coder les frais en dur. En Paper, on utilise des frais
  configurables avec une valeur par défaut prudente (taker du palier le plus bas).
  En Live, on lit les frais réels via `GET /transaction_summary`.

### 3.9 France / UE
- 🟡 Coinbase dispose d'une licence MiCA (CSSF, Luxembourg) et d'un enregistrement PSAN
  auprès de l'AMF.
- ❓ **La liste des produits tradables depuis la France via l'API n'est pas documentée
  publiquement.** Le seul mécanisme fiable est `get_tradability_status` sur l'endpoint
  authentifié. Le Radar (phase 1) affichera donc tous les produits SPOT actifs, avec une
  mention « tradabilité non vérifiée » tant qu'aucune clé n'est configurée.

## 4. Décisions d'architecture découlant de l'audit

- **Aucun SDK Coinbase en dépendance.** Le SDK TypeScript est un « sample »
  (`@coinbase-sample/...`, v0.3.0), pas un SDK officiel supporté. L'API REST et le
  WebSocket sont simples : un client maison typé et validé par Zod suffit, et il est plus
  sûr et plus auditable.
- **Persistance V1 :** SQLite local (fichier) ou JSONL pour les logs. PostgreSQL sera
  ajouté plus tard pour le 24/7 sur VPS, derrière une interface `Repository`.
- **Monorepo pnpm :** `apps/server` (Node, moteurs et API), `apps/dashboard` (Next.js),
  `packages/core` (types, schémas Zod et logique pure testable).
- Le backend est le **seul** à parler à Coinbase. Le dashboard ne consomme que l'API locale.

## 5. Points ambigus / bloquants à trancher

1. **Accès réseau de l'environnement cloud** : `api.coinbase.com`,
   `advanced-trade-ws.coinbase.com` et `docs.cdp.coinbase.com` sont bloqués ici.
   Je peux développer avec des données simulées (fixtures conformes aux schémas),
   mais je ne peux pas valider la connexion réelle depuis cet environnement.
2. **Limites de débit REST** : les sources se contredisent (10/30 req/s ou 3/5 req/s).
   Mitigation : limiteur prudent (≤ 3 req/s en public) et lecture des en-têtes `x-ratelimit-*`.
3. **Nombre maximal de produits par abonnement WebSocket** : non documenté dans les
   extraits obtenus. Mitigation : abonnements par lots (sharding sur plusieurs connexions)
   avec une taille configurable, et mesure réelle au premier lancement local.
4. **Tradabilité en France** : vérifiable seulement avec une clé authentifiée (§3.9).
