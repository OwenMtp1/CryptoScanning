# Crypto Radar — Coinbase Autonomous Trading Radar

Application **locale** de surveillance du marché Coinbase qui détecte les mouvements anormaux (« bumps »).
Elle est conçue pour évoluer ensuite vers le Paper Trading, puis vers le Live Trading sous un Risk Engine obligatoire.

> **Phase actuelle : 2 — PAPER TRADING + RISK ENGINE.** Deux modes :
> - `MODE=RADAR` (par défaut) : observation, aucune exécution ;
> - `MODE=PAPER` : trading simulé sur le carnet live, sans aucun ordre réel ni clé API.
>
> Le mode **LIVE est refusé au démarrage** : il n'est pas implémenté.

## Démarrage rapide

Prérequis : Node.js ≥ 22.12 et pnpm 10.

```bash
pnpm install
pnpm dev            # API locale (127.0.0.1:4000) + dashboard (http://localhost:3000)
```

Par défaut, les données sont **simulées** (`DATA_SOURCE=simulated`). Un bandeau jaune le rappelle en permanence dans le dashboard.
Le simulateur produit des trames au format exact de Coinbase et injecte des scénarios (pump, dump, pump illiquide, pic de volume) pour qu'on puisse vérifier la détection.

### Trading simulé (paper)

```bash
MODE=PAPER pnpm dev:server   # dans un terminal
pnpm dev:dashboard           # dans un autre
```

Portefeuille virtuel par défaut : 500 € (400 € protégés, 100 € tradables), 10 € max par trade.
Tout ordre passe par le **Risk Engine**. Le bouton 🛑 **EMERGENCY STOP** bloque immédiatement toute nouvelle entrée.
Détails et hypothèses (notamment les **frais**) : [docs/03-phase-2-paper-trading.md](docs/03-phase-2-paper-trading.md).

### Connecter ton compte Coinbase (lecture seule, optionnel)

Clé CDP **View uniquement**, sans Transfer (une clé avec Transfer est refusée). Elle donne accès :
- aux soldes ;
- au **palier de frais réel**, appliqué au paper trading ;
- aux produits disponibles pour ton compte.

Aucun ordre n'est passé. Voir [docs/05-coinbase-integration.md](docs/05-coinbase-integration.md).

### Passer aux données Coinbase réelles (publiques, sans clé)

```bash
cp .env.example .env
# dans .env : DATA_SOURCE=coinbase
pnpm dev
```

Seuls les endpoints **publics** sont utilisés : `GET /market/products` (REST) et `wss://advanced-trade-ws.coinbase.com`, canaux `ticker`, `market_trades` et `heartbeats`.
Au premier lancement réel, vérifie dans la page **Journal** les événements `PRODUCTS_LOADED`, `WS_CONNECTED` et `WS_SUBSCRIBED` (voir [docs/02-phase-1-radar.md](docs/02-phase-1-radar.md#checklist-de-validation-locale)).

## Commandes

| Commande | Rôle |
|---|---|
| `pnpm dev` | serveur + dashboard en mode développement |
| `pnpm dev:server` / `pnpm dev:dashboard` | l'un ou l'autre |
| `pnpm test` | tests automatisés (core + serveur) |
| `pnpm typecheck` | vérification TypeScript de tous les paquets |
| `pnpm build` | build de production du dashboard |

## Structure

```
packages/core      logique pure et testable (aucune I/O)
  src/coinbase       schémas Zod des payloads Coinbase, décodeur WebSocket, filtre produits
  src/market         séries temporelles 1 s, état de marché, métriques
  src/signals        Signal Engine : détection, scores 0–100, opportunités
  src/trading        Strategy Engine, Risk Engine, disjoncteurs, positions, exécution paper, rotation, stats
  src/logging        types d'événements, filtres, masquage des secrets
  src/simulation     simulateur au format Coinbase (PRNG déterministe)
  src/api            contrat de l'API locale (types partagés avec le dashboard)
apps/server        backend local Node.js (seul composant qui parle à Coinbase)
  src/market-data    client REST public, flux WebSocket, source simulée, Market Data Engine
  src/signal-engine  service radar (évaluation périodique)
  src/trading        TradingService (stratégie → risque → exécution), persistance paper
  src/logging        journal JSONL horodaté (data/logs/)
  src/api            API HTTP en lecture seule + flux SSE
  src/config         variables d'environnement validées par Zod
apps/dashboard     Next.js + Tailwind (Radar, Opportunités, Positions, Portefeuille, Stratégies, Journal, Paramètres)
config/            configuration des signaux (exemple versionné)
docs/              audit Coinbase, architecture, bilan de phase
```

Détails : [docs/01-architecture.md](docs/01-architecture.md).

## Configuration

- `.env` (voir [.env.example](.env.example)) : mode, source, devises, limites réseau. **Jamais committé.**
- `config/signal-config.json` (optionnel, à partir de [config/signal-config.example.json](config/signal-config.example.json)) : seuils, fenêtres, poids du score, critères de liquidité.
- `config/trading.json` (optionnel, à partir de [config/trading.example.json](config/trading.example.json)) : capital, limites de risque, frais et paramètres de simulation, stratégies, rotation.
- `data/strategies.json` : écrit par le **Strategy Builder** (page Stratégies). Quand il existe, il remplace les stratégies de `config/trading.json`.

Les deux fichiers sont validés par Zod au démarrage ; une valeur invalide empêche le serveur de démarrer. Une stratégie sans stop loss, ou demandant plus que `maxTradeQuote`, est refusée.

## Sécurité

- Aucune clé API n'est lue ni requise. Les futures clés resteront côté serveur, avec **View + Trade**, jamais **Transfer**.
- Le Risk Engine est la **seule** porte vers l'exécution : entrées, sorties et rotations y passent toutes. Les sorties de protection ne sont jamais bloquées.
- L'API locale écoute sur `127.0.0.1` et refuse les en-têtes `Host` non locaux (protection DNS rebinding). Le CORS est limité aux origines du dashboard.
  Les seules routes `POST` sont l'emergency stop, la réactivation et le reset paper, protégées par un en-tête dédié et une confirmation. Aucune route ne passe d'ordre ni ne modifie une limite.
- Tout ce qui est journalisé ou exposé passe par un masquage des secrets (clés PEM, JWT, en-têtes Bearer, champs nommés secret/token/apiKey…).
- Des données obsolètes (pas de message ni de heartbeat depuis 15 s) **suspendent tous les signaux**.
- Le score d'opportunité mesure la **qualité interne du signal**. Ce n'est pas une prévision de rendement.

## Feuille de route

1. ✅ Architecture, données publiques, WebSocket, radar, Signal Engine, logs, dashboard
2. ✅ Risk Engine, disjoncteurs, emergency stop, Paper Trading (même Strategy/Risk Engine que le futur Live)
3. ✅ Strategy Builder visuel ([docs/04-strategy-builder.md](docs/04-strategy-builder.md))
4. ⏭ Backtesting (train / out-of-sample)
5. Notifications, puis connexion trading Coinbase et Live avec confirmations multiples
