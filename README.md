# Crypto Radar — Coinbase Autonomous Trading Radar

Application **locale** de surveillance du marché Coinbase qui détecte les mouvements anormaux (« bumps »).
Elle est conçue pour évoluer ensuite vers le Paper Trading, puis vers le Live Trading sous un Risk Engine obligatoire.

> **Phase actuelle : 1 — RADAR.** Le système observe uniquement : aucun ordre, aucune clé API, aucune transaction.
> Les modes PAPER et LIVE sont **refusés au démarrage** tant qu'ils ne sont pas implémentés.

## Démarrage rapide

Prérequis : Node.js ≥ 22.12 et pnpm 10.

```bash
pnpm install
pnpm dev            # API locale (127.0.0.1:4000) + dashboard (http://localhost:3000)
```

Par défaut, les données sont **simulées** (`DATA_SOURCE=simulated`). Un bandeau jaune le rappelle en permanence dans le dashboard.
Le simulateur produit des trames au format exact de Coinbase et injecte des scénarios (pump, dump, pump illiquide, pic de volume) pour qu'on puisse vérifier la détection.

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
  src/logging        types d'événements, filtres, masquage des secrets
  src/simulation     simulateur au format Coinbase (PRNG déterministe)
  src/api            contrat de l'API locale (types partagés avec le dashboard)
apps/server        backend local Node.js (seul composant qui parle à Coinbase)
  src/market-data    client REST public, flux WebSocket, source simulée, Market Data Engine
  src/signal-engine  service radar (évaluation périodique)
  src/logging        journal JSONL horodaté (data/logs/)
  src/api            API HTTP en lecture seule + flux SSE
  src/config         variables d'environnement validées par Zod
apps/dashboard     Next.js + Tailwind (Radar, Opportunités, Journal, Paramètres)
config/            configuration des signaux (exemple versionné)
docs/              audit Coinbase, architecture, bilan de phase
```

Détails : [docs/01-architecture.md](docs/01-architecture.md).

## Configuration

- `.env` (voir [.env.example](.env.example)) : mode, source, devises, limites réseau. **Jamais committé.**
- `config/signal-config.json` (optionnel, à partir de [config/signal-config.example.json](config/signal-config.example.json)) : seuils, fenêtres, poids du score, critères de liquidité.
  Le fichier est validé par Zod au démarrage ; une valeur invalide empêche le serveur de démarrer.

## Sécurité (phase 1)

- Aucune clé API n'est lue ni requise. Les futures clés resteront côté serveur, avec **View + Trade**, jamais **Transfer**.
- L'API locale écoute sur `127.0.0.1`, n'accepte que `GET` et refuse les en-têtes `Host` non locaux (protection DNS rebinding). Le CORS est limité aux origines du dashboard.
- Tout ce qui est journalisé ou exposé passe par un masquage des secrets (clés PEM, JWT, en-têtes Bearer, champs nommés secret/token/apiKey…).
- Des données obsolètes (pas de message ni de heartbeat depuis 15 s) **suspendent tous les signaux**.
- Le score d'opportunité mesure la **qualité interne du signal**. Ce n'est pas une prévision de rendement.

## Feuille de route

1. ✅ Architecture, données publiques, WebSocket, radar, Signal Engine, logs, dashboard
2. ⏭ Paper Trading (même Strategy/Risk Engine que le Live)
3. Risk Engine, circuit breakers, emergency stop
4. Strategy Builder, backtesting (train / out-of-sample)
5. Notifications, puis connexion trading Coinbase et Live avec confirmations multiples
