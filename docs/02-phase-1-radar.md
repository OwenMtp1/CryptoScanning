# Phase 1 — Radar (bilan)

## Livré

| Demande (§30) | Réalisation |
|---|---|
| 1. Architecture | monorepo pnpm : `packages/core` (logique pure), `apps/server`, `apps/dashboard` |
| 2. Dashboard | Next.js + Tailwind : pages Radar, Opportunités, Journal, Paramètres |
| 3. Données publiques Coinbase | client REST public (débit limité, reprises sur 429/5xx, validation Zod) |
| 4. Produits dynamiques | `GET /market/products` paginé, puis filtre de tradabilité publique |
| 5. WebSocket | `ticker`, `market_trades` et `heartbeats`, avec sharding, watchdog et reconnexion |
| 6. Prix temps réel | flux SSE vers le dashboard, rafraîchi toutes les secondes |
| 7. Variations | 10 s / 30 s / 1 min / 5 min, ratio de volume, accélération, volatilité, spread, profondeur |
| 8. Signal Engine | 5 types de signaux, scores 0–100 pondérés et configurables, contrôle de liquidité |
| 9. Radar des bumps | tableau triable et filtrable, niveaux d'alerte, opportunités détaillées |
| 10. Logs | journal JSONL horodaté et masqué, page Activity Log avec filtres |

## Tests (75 tests automatisés)

`pnpm test` couvre notamment :

- **Décodage** : format Coinbase, horodatages à la nanoseconde, trames invalides (jamais d'exception), trames d'erreur.
- **Filtre produits** : non-SPOT, hors ligne, désactivé, cancel-only, view-only, enchère, devise non autorisée, alias.
- **Métriques** : fenêtres, carry-forward, rétention, baseline 24h puis historique, trades du snapshot exclus, dédoublonnage, horodatages futurs rejetés, accélération (exemple du cahier des charges : +0,5 → +1,2 → +2,4 → +4 %).
- **Signal Engine** :
  - marché plat → aucun signal ;
  - pump → opportunité tradable ;
  - pump illiquide → `LIQUIDITY_WARNING` et opportunité **non tradable** ;
  - flux obsolète → aucun signal ;
  - cooldown et expiration ;
  - bornes des scores et poids configurables.
- **De bout en bout** : simulateur → décodeur → état → moteur, avec un pump injecté sur SOL-EUR détecté et un pump illiquide jamais présenté comme tradable.
- **Serveur** :
  - REST : pagination, reprises, pas de reprise sur les 4xx, API indisponible, débit limité ;
  - WebSocket : abonnements sans JWT, débit limité, backoff, watchdog, arrêt propre ;
  - santé du flux : données obsolètes puis rétablies, heartbeats absents, trous de séquence ;
  - journal : persistance, masquage, rechargement au redémarrage ;
  - API : lecture seule, protection DNS rebinding, CORS, absence de secrets, SSE ;
  - validation de l'environnement et de la configuration.

Mesure sur 20 minutes de marché simulé **sans scénario injecté** : aucune opportunité ouverte. Les signaux isolés viennent surtout des actifs illiquides, qui sont correctement marqués.

## Décisions et limites connues

- **Aucun SDK Coinbase.** Le SDK TypeScript publié est un « sample » (`@coinbase-sample/…`). Les formats ont été vérifiés dans le SDK Python officiel v1.8.4 (voir [l'audit](00-audit-et-verification-coinbase.md)).
- **Liquidité = top-of-book** (meilleur bid/ask du ticker) + volume 24h. Le carnet complet (`level2`, reçu sous le canal `l2_data`) pourra être ajouté pour les produits candidats, sans s'abonner au carnet de tout l'univers.
- **Devises mélangées** (EUR, USDC) : les seuils de liquidité sont exprimés en devise de cotation, sans conversion. L'écart EUR/USDC est acceptable pour un filtre, mais pas pour du sizing.
- **Alias** : un produit dont `alias` pointe vers un autre produit sélectionné est ignoré (heuristique, voir `filterRadarProducts`).
- **Séquences WebSocket** : `sequence_num` est suivi par connexion ; un trou est journalisé comme avertissement, sans resynchronisation.
- **Tradabilité réelle compte/région** : non vérifiable sans clé (`get_tradability_status`, endpoint authentifié). Le dashboard affiche « non vérifiée ».
- **Configuration** en lecture seule dans le dashboard. Elle se modifie via fichiers et un redémarrage, par choix de sécurité : pas d'endpoint mutable en phase 1.
- Dans cet environnement de développement cloud, `api.coinbase.com` et le WebSocket sont bloqués par le proxy réseau (HTTP 403). Le mode `DATA_SOURCE=coinbase` a donc été testé avec des doubles de test, pas contre Coinbase.
  En réel, le serveur journalise l'échec, reste disponible et retente toutes les 30 s.

## Checklist de validation locale

À faire une fois sur ta machine avec `DATA_SOURCE=coinbase` :

1. `pnpm dev`, puis ouvrir http://localhost:3000. Le bandeau « DONNÉES SIMULÉES » doit **disparaître**.
2. Journal → `PRODUCTS_LOADED` : noter le nombre de produits reçus et éligibles, ainsi que les motifs de rejet (`data.rejected`).
   - Si `invalid > 0` : un champ ne correspond pas aux schémas → me transmettre l'événement.
3. Journal → `WS_CONNECTED` puis `WS_SUBSCRIBED` pour `heartbeats`, `ticker` et `market_trades`, sur chaque connexion.
4. Aucun `API_ERROR` ni `WS_DECODE_ERROR` répété. Un message d'erreur Coinbase (ex. limite d'abonnement) apparaît en `API_ERROR`.
5. En-tête : « Flux Coinbase OK ». Paramètres : dernier heartbeat récent, reconnexions et trous de séquence à 0.
6. Radar : les prix bougent. Après 5 min, les variations 5m et la baseline historique (plus d'astérisque) apparaissent.
7. Si des connexions se ferment avec beaucoup de produits : réduire `WS_PRODUCTS_PER_CONNECTION`, car la limite réelle n'est pas documentée dans les sources consultées.

## Prochaine étape proposée : Paper Trading

Je commencerai par un plan détaillé (interfaces `StrategyEngine`, `RiskEngine`, `ExecutionEngine`, simulation des fills), puis j'implémenterai.
