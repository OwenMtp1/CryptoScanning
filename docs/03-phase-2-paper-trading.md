# Phase 2 — Paper Trading + Risk Engine (bilan)

Lancer : `MODE=PAPER` dans `.env` (ou `MODE=PAPER pnpm dev`). Sans modification, les données restent simulées.
En `MODE=RADAR`, le pipeline complet tourne aussi (stratégie → Risk Engine), mais **rien n'est exécuté**. On voit ainsi ce que le bot *aurait* fait.

## Chaîne de décision

```
RadarRow ─► Strategy Engine ─► OrderIntent ─► RISK ENGINE ─► Execution (paper) ─► Fill ─► Position
 (signaux)   (conditions)       (ENTRY)        barrière       latence, frais,             stop / trailing /
                                               unique         slippage, partiel           take profit / durée
                                                                                   │
                                          POSITION_CLOSED ─► rotation BTC/ETH ─► (Risk Engine à nouveau)
```

- **Un seul chemin vers l'exécution** : `TradingService.processIntent()`. Entrées, sorties et rotations passent toutes par `checkIntent()`.
- Le Risk Engine (`packages/core/src/trading/risk.ts`) est une fonction pure. Il évalue **tous** les contrôles, sans s'arrêter au premier échec, et journalise chaque raison de refus.
- Le Paper et le futur Live partagent le même Strategy Engine, le même Risk Engine et le même modèle de positions. Seule l'implémentation de l'exécution changera.

## Contrôles du Risk Engine

| Entrées | Contrôle |
|---|---|
| 1 | capital disponible (ordres en vol inclus) |
| 2 | capital protégé : total − protégé − engagé − ordre ≥ 0 |
| 3 | taille max. par trade, taille min. du produit |
| 4 | exposition par actif et exposition totale |
| 5 | nombre de positions (ordres en vol inclus) |
| 6–7 | perte 24 h / 7 j glissants : réalisé + pertes latentes (frais de sortie inclus) |
| 8 | trades par heure / par 24 h |
| 9 | cooldown après une perte |
| 10–11 | spread, profondeur top-of-book, volume 24h, slippage estimé |
| 12 | état du marché : produit SPOT online, pas cancel-only / limit-only / view-only / enchère, coté dans la devise du compte |
| 13 | fraîcheur des données (flux sain + dernière donnée ≤ 10 s) |
| 14 | état de la connexion à l'exchange |
| 15 | erreurs précédentes (erreurs consécutives) |
| + | emergency stop, disjoncteurs, cohérence du prix, doublon (position ou ordre déjà en cours sur le produit) |

**Sorties.** Elles ne sont *jamais* bloquées par les pertes, le cooldown, l'emergency stop ou les disjoncteurs : bloquer un stop augmenterait le risque.
Elles vérifient seulement trois points :
- la vente porte uniquement sur la quantité d'**une position du bot** (la réserve BTC/ETH est intouchable) ;
- un prix récent existe (≤ 60 s) ;
- aucun ordre n'est déjà en cours sur le produit.

**Rotations.** Bloquées par l'emergency stop et les disjoncteurs, et limitées aux liquidités disponibles.

## Disjoncteurs et Emergency Stop

| Disjoncteur | Déclenchement | Réactivation |
|---|---|---|
| `EMERGENCY_STOP` | bouton 🛑 du dashboard | manuelle (« RESUME ») |
| `DAILY_LOSS` / `WEEKLY_LOSS` | perte 24 h / 7 j ≥ limite | manuelle |
| `API_ERRORS` | N erreurs consécutives | manuelle |
| `SLIPPAGE` | slippage réalisé > max | manuelle |
| `EXECUTION_REJECTIONS` | trop d'ordres non exécutés en 1 h | manuelle |
| `TRADE_RATE` | exécutions > 2 × max/h (défense en profondeur) | manuelle |
| `STALE_DATA` | flux obsolète | automatique au retour des données |

Effet de tout disjoncteur déclenché :
- les nouvelles entrées sont bloquées ;
- l'état est conservé et persisté (les disjoncteurs manuels survivent à un redémarrage) ;
- un bandeau s'affiche dans le dashboard ;
- l'événement `BOT_PAUSED` / `BOT_STOPPED` est journalisé.

Les notifications externes (Discord, Telegram) viendront dans la phase Notifications.

## Simulation d'exécution (ordres MARKET)

| Élément | Modèle |
|---|---|
| Spread | achat au ask, vente au bid |
| Latence | 150–600 ms ; le carnet utilisé est celui **au moment du fill** |
| Slippage | aléatoire (0–2 bps) + impact proportionnel à taille / profondeur top-of-book |
| Exécution partielle | au-delà de 3 × la profondeur disponible ; le reste est annulé (IOC) et une sortie partielle est reprise au tick suivant |
| Ordres non exécutés | 1 % de probabilité, ou carnet indisponible |
| Tailles | arrondi à `base_increment`, refus sous `base_min_size` / `quote_min_size` |
| Frais | taker **1,2 %**, inclus dans le montant d'un achat, déduits du produit d'une vente |

> ⚠️ **Hypothèse sur les frais non vérifiée** : la doc Coinbase était inaccessible depuis l'environnement de développement. 1,2 % est volontairement prudent.
> Vérifie ton palier dans Coinbase Advanced → Fees et règle `paper.takerFeePct` dans `config/trading.json`. En Live, les frais réels seront lus via `GET /transaction_summary`.

**Conséquence à connaître.** Avec 1,2 % de frais, un aller-retour coûte environ 2,4 %.
La stratégie par défaut (stop −2 %, trailing 2 %) perd donc de l'argent sur la plupart des trades, même quand le prix de sortie dépasse le prix d'entrée : c'est ce qu'on a observé dans les tests.
Le Paper Trading sert précisément à le voir avant d'y mettre de l'argent réel.

## Portefeuille (paper)

Valeurs par défaut, reprises de l'exemple du cahier des charges :

| Poste | Montant |
|---|---|
| Liquidités | 100 € |
| BTC | 200 € |
| ETH | 200 € |
| **Total** | **500 €** |
| Capital protégé | 400 € |
| Max par trade | 10 € |

Définitions :
- **total** = liquidités + valeur de toutes les positions et réserves ;
- **tradable** = total − protégé ;
- **engagé** = valeur des positions ouvertes ;
- **disponible** = min(liquidités, tradable − engagé).

Si le BTC et l'ETH baissent, le capital tradable diminue automatiquement. Le bot ne peut donc jamais puiser dans le capital protégé.

**Rotation** (optionnelle, par stratégie). Deux modes :
- `profit_only` (par défaut) : seul le profit réalisé part en BTC/ETH ;
- `proceeds` : tout le capital récupéré part en BTC/ETH, comme dans l'exemple SOL du cahier des charges.

**Persistance.** L'état est dans `data/paper/state.json`, écrit de façon atomique. Un fichier corrompu **empêche le démarrage** : aucune remise à zéro silencieuse. La réinitialisation se fait via le bouton de la page Portefeuille, avec confirmation « RESET ».

## Dashboard

- **En-tête** : badge 🟢 PAPER MODE, bouton 🛑 EMERGENCY STOP, bandeau rouge ou orange quand le bot est bloqué, avec réactivation manuelle.
- **Radar** : capital, P&L, positions et niveau de risque (LOW / MEDIUM / HIGH / BLOCKED). Le fil d'événements inclut les ouvertures, fermetures, stops et refus.
- **Opportunités** : pour chaque stratégie, les conditions (✓ / ✗), l'action proposée, les frais estimés et le verdict **Risk Engine APPROVED / REJECTED** avec ses raisons.
- **Positions** : entrée, prix actuel, plus haut, stop, trailing, niveau de sortie, durée, signal initial → actuel, conditions de sortie.
- **Portefeuille** :
  - capital total / protégé / tradable / engagé / disponible ;
  - réserves ;
  - indicateurs de performance (P&L, win rate, profit factor, drawdown, frais, slippage) ;
  - courbe du P&L trading ;
  - historique complet des trades.
- **Paramètres** : capital, risque, simulation, stratégies et rotation.

## Sécurité de l'API

Les seules routes `POST` sont des contrôles de sécurité : emergency stop, réactivation, reset paper. Elles exigent :
- l'en-tête `x-radar-action: confirm`, qu'une page web tierce ne peut pas envoyer sans passer le preflight CORS ;
- une origine autorisée ;
- un corps JSON validé par Zod (« RESUME » / « RESET »).

Aucune route ne permet de passer un ordre, de modifier une limite ou de déplacer des fonds.

## Tests (130 au total)

- **Risk Engine** : un scénario d'attaque par limite. Trade trop gros, capital protégé, positions, expositions, pertes 24 h / 7 j (latentes incluses), nombre de trades, cooldown, erreurs, spread, liquidité, slippage, données obsolètes, flux coupé, produit inéligible ou limit-only, prix incohérent, taille min., doublon, entrées parallèles en vol, vente à découvert, vente de la réserve BTC, emergency stop, disjoncteurs.
- **Positions** : stop depuis l'entrée (100 → 98), trailing (100 → 105 → 110, sortie à 107,8), take profit, durée max., sorties partielles, P&L frais inclus.
- **Exécution paper** : frais, spread, slippage croissant avec la taille, exécution partielle, non exécuté, incréments et minimums.
- **De bout en bout sur marché simulé** :
  - pump → déclenchement → Risk Engine → fill → position → sortie → rotation ;
  - emergency stop (entrées bloquées, sorties maintenues) ;
  - RADAR sans exécution ;
  - persistance et redémarrage ;
  - fichier corrompu refusé ;
  - reset ;
  - invariants (liquidités ≥ 0, engagé ≤ tradable) vérifiés à chaque seconde.
- **API** : protections des routes `POST`.
- **Modes** : `LIVE` refusé.

## Limites connues

- Pertes 24 h / 7 j en **fenêtres glissantes**, et non par jour calendaire.
- Ordres MARKET uniquement. Les ordres limite viendront avec la connexion trading Coinbase (étape 12), après vérification de la doc officielle.
- Profondeur limitée au top-of-book (pas de carnet `level2`), donc le slippage des gros ordres est approximatif. Sans importance pour des ordres de 10 €.
- Les ordres en vol sont perdus au redémarrage ; les positions en cours de sortie redeviennent « open » et la sortie est retentée.

## Suite

Étape 9 : Strategy Builder visuel. Le format JSON des stratégies est déjà celui qu'il éditera.
Ensuite, le backtesting, qui rejouera l'historique à travers les mêmes Strategy Engine, Risk Engine et exécution paper.
