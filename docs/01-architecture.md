# Architecture

## Vue d'ensemble

```
             ┌──────────────────────── apps/server (Node, 127.0.0.1) ────────────────────────┐
Coinbase ──► │ MarketDataSource ──► MarketDataEngine ──► RadarService ──► API HTTP + SSE     │ ──► apps/dashboard
 (REST+WS)   │ (Coinbase | Simulé)   décodage, état,      SignalEngine      lecture seule    │     (Next.js)
             │                       fraîcheur            (core)                             │
             │                                 └──────────► EventLog (JSONL) ◄───────────────┤
             └───────────────────────────────────────────────────────────────────────────────┘
                 phases suivantes : StrategyEngine ─► RiskEngine (barrière) ─► ExecutionEngine
```

Principes :

- **Le backend est le seul composant qui parle à Coinbase.** Le dashboard ne consomme que l'API locale et ne manipule aucun secret.
- **Logique pure dans `packages/core`** : aucun accès réseau, disque ou horloge. Le temps est toujours passé en paramètre, ce qui rend tout déterministe et testable.
  Le futur moteur de backtest pourra donc rejouer des données historiques dans exactement le même code.
- **Même chemin pour les données réelles et simulées.** Le simulateur produit des trames au format Coinbase, qui passent par les mêmes schémas Zod et le même décodeur.
- **Aucune IA dans la boucle temps réel.** Tous les calculs sont locaux et déterministes.

## Flux de données

1. **Produits.** La liste est récupérée dynamiquement (`GET /market/products?product_type=SPOT`, paginée) puis filtrée par `filterRadarProducts`. Aucune liste de cryptos n'est codée en dur.
   Sont exclus :
   - les produits non SPOT ;
   - les produits dont le statut n'est pas `online` ;
   - les produits `trading_disabled`, `is_disabled`, `cancel_only`, `view_only` ou `auction_mode` ;
   - les devises de cotation non autorisées ;
   - les alias en doublon.

   Les produits retenus sont classés par volume 24h en devise de cotation, puis plafonnés à `MAX_PRODUCTS`.
2. **WebSocket** (`CoinbaseWsFeed`) :
   - répartition des produits sur plusieurs connexions (`WS_PRODUCTS_PER_CONNECTION`) ;
   - un message d'abonnement par canal : `heartbeats`, `ticker`, `market_trades` ;
   - débit d'abonnement limité globalement (≤ 4 msg/s, pour une limite documentée de 8/s/IP) ;
   - watchdog de 15 s qui reconnecte une connexion silencieuse, avec backoff exponentiel et jitter.
3. **Décodage** (`decodeCoinbaseFrame`) : validation Zod et conversion des décimales envoyées en chaînes. La fonction ne lève jamais d'exception : les éléments invalides sont comptés et journalisés.
4. **État** (`MarketStateStore`) : pour chaque produit, un tampon circulaire de buckets d'une seconde (dernier prix, volume, nombre de trades), plus le dernier ticker (bid, ask, quantités).
   - Les trades sont dédupliqués par `trade_id`, ce qui neutralise les rejeux après reconnexion.
   - Les trades du snapshot initial ne comptent pas dans l'historique « live ».
   - Les événements datés de plus de 5 min dans le futur sont rejetés.
5. **Métriques** (`computeMetrics`), calculées à l'horloge de l'exchange :
   - variation sur 10 s, 30 s, 1 min et 5 min ;
   - ratio de volume par rapport à une baseline ;
   - accélération, mesurée sur des segments consécutifs ;
   - volatilité ;
   - spread et profondeur au meilleur prix (top-of-book).
6. **Signal Engine** : signaux `PRICE_SURGE`, `PRICE_DROP`, `VOLUME_SPIKE`, `ACCELERATION` et `LIQUIDITY_WARNING`, avec un cooldown par (produit × type × fenêtre). Il calcule ensuite les scores et gère le cycle de vie des opportunités.
7. **Journal** : chaque événement est horodaté, masqué (secrets), gardé en mémoire et ajouté au fichier `data/logs/events-AAAA-MM-JJ.jsonl`.

## Scores (0–100)

| Composant | Calcul (atteint 100 quand…) |
|---|---|
| Momentum | meilleure hausse rapportée au seuil de sa fenêtre ; seuil → 50, 2× le seuil → 100 |
| Volume | ratio volume récent / baseline ; `spikeRatio` → 50, 2× → 100 |
| Accélération | dernier segment − moyenne des segments précédents ; `refs.accelerationPct` → 100 |
| Liquidité | 50 % spread, 30 % profondeur top-of-book (échelle log), 20 % volume 24h (échelle log) |
| Volatilité | écart-type des rendements sur 10 s, calculé sur 5 min ; `refs.volatilityPct` → 100 |

`composite` est la moyenne pondérée des composants. Les poids sont configurables, et au moins un poids doit être > 0.
Ce score mesure la **qualité interne du signal**, pas un rendement attendu.

**Baseline de volume.** Tant que l'historique local est inférieur à `minBaselineHistorySec` (5 min par défaut), la baseline est dérivée du volume 24h (`volume_24_h × prix / 86 400 × fenêtre`).
Ensuite, elle vient de l'historique local (jusqu'à 30 min), fenêtre récente exclue. Le radar indique la source utilisée (astérisque et info-bulle).

**Liquidité.** Un produit est déclaré non tradable si le spread dépasse `maxSpreadPct`, si la profondeur ou le volume 24h passent sous leurs minimums, ou si ces données manquent. Une opportunité sur un tel produit reste visible, mais marquée **NON TRADABLE**.

## Opportunités

Une opportunité s'ouvre si les trois conditions sont réunies :
- le flux est sain ;
- `composite ≥ opportunity.minScore` ;
- un `PRICE_SURGE` est actif, ou un `VOLUME_SPIKE` avec un momentum 1 min positif.

Elle expire après `expireAfterSec` passées sous `minScore − hysteresis`, ou dès que le flux devient obsolète pendant ce délai.
En phase 1, l'action proposée est toujours « Aucune — mode RADAR ».

## Correspondance avec les modules du cahier des charges

| Module demandé | Emplacement | État |
|---|---|---|
| market-data | `apps/server/src/market-data`, `packages/core/src/{coinbase,market}` | ✅ phase 1 |
| signal-engine | `packages/core/src/signals`, `apps/server/src/signal-engine` | ✅ phase 1 |
| dashboard | `apps/dashboard` | ✅ phase 1 (lecture seule) |
| config | `apps/server/src/config`, `config/` | ✅ phase 1 |
| database | journal JSONL (V1) ; interface `Repository` + PostgreSQL pour le 24/7 | partiel |
| notifications | événements déjà typés dans `EVENT_TYPES` | à venir |
| strategy-engine, risk-engine, portfolio, execution, paper-trading, backtesting | — | à venir, dans cet ordre, selon le plan |

Les types d'événements des phases suivantes (`ORDER_*`, `POSITION_*`, `RISK_CHECK`…) sont déjà réservés, pour que le format du journal reste stable.
