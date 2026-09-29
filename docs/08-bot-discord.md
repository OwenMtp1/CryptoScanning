# 08 — Bot Discord 24 h/24 (Cloudflare Worker, gratuit)

Le site en ligne n'analyse que lorsque la page est ouverte. Ce **worker** tourne en permanence chez Cloudflare :
**toutes les 5 minutes**, il analyse le marché et envoie les alertes dans ton salon Discord, même quand ton ordinateur et
ton téléphone sont éteints.

## Ce qu'il surveille

- **Coinbase** : toutes les cryptos cotées en USD/USDC, avec les hausses et chutes sur 5 et 15 minutes.
- **CoinGecko** (750 plus grosses capitalisations) : top hausses/krachs sur 1 h, volumes anormaux, proximité du record,
  tendances, funding et open interest, nouveaux jetons et pumps DEX, risques de rug.
- **Actualités** : les 8 médias du site.
- **Confluences** entre ces types d'indices (prix + actualités, prix + dérivés…).

CoinGecko et les actualités sont lus **via ton site** (`SITE_URL`) : le worker profite du même cache et ne consomme pas
de quota CoinGecko en plus.

Binance n'est pas utilisé ici, car Binance refuse les serveurs Cloudflare. Coinbase et CoinGecko le remplacent.

## Quelles alertes arrivent ?

- **Alerte immédiate :** signaux de force **≥ 70** et toutes les **confluences**. Pas plus d'une alerte par heure pour une
  même crypto dans le même sens.
- **Résumé toutes les 15 min :** les signaux un peu plus faibles (≥ 55).
- **Au maximum 30 messages par heure.** Jamais de `@everyone`.
- **Au tout premier passage,** le worker envoie seulement « ✅ Crypto Radar connecté ». Il apprend l'état du marché sans
  alerter sur tout ce qui bouge déjà.

## Mise en place (≈ 10 minutes)

### 1. Crée le webhook Discord

1. Dans ton serveur Discord, fais un clic droit sur le salon voulu → **Modifier le salon**, puis **Intégrations** →
   **Webhooks** → **Nouveau webhook**.
2. Donne-lui un nom (par ex. « Crypto Radar ») → **Copier l'URL du webhook**.

⚠️ **Cette URL est secrète** : quiconque l'a peut écrire dans ton salon. Ne la mets ni dans GitHub ni dans un message.

### 2. Crée le worker sur Cloudflare

1. **Workers & Pages** → **Créer** → onglet **Workers** → **Importer un dépôt** (« Import a repository »), puis choisis
   **CryptoScanning**.
2. Réglages :

   | Champ | Valeur |
   |---|---|
   | Nom du projet | `crypto-radar-discord` (**exactement**, c'est le nom indiqué dans `wrangler.toml`) |
   | Commande de build | *laisser vide* |
   | Commande de déploiement | `npx wrangler deploy` |
   | Répertoire racine (avancé) | `deploy/discord-worker` |
   | Branche | `claude/coinbase-trading-radar-xbpo4i` (si le champ est proposé) |

3. **Déployer**.

### 3. Ajoute les réglages du worker

Dans le worker `crypto-radar-discord` → **Settings** → **Variables and Secrets** → **Add** :

| Type | Nom | Valeur |
|---|---|---|
| **Secret** | `DISCORD_WEBHOOK_URL` | l'URL copiée à l'étape 1 |
| Text | `SITE_URL` | l'adresse de ton site, par ex. `https://crypto-radar.pages.dev` |
| **Secret** (facultatif) | `DISCORD_WEBHOOK_BULLISH` | webhook d'un salon réservé aux signaux **haussiers** |
| **Secret** (facultatif) | `DISCORD_WEBHOOK_BEARISH` | webhook d'un salon réservé aux signaux **baissiers** |
| Text (facultatif) | `DISCORD_MIN_STRENGTH` | seuil d'alerte immédiate, `70` par défaut (monte à `80` si c'est trop bavard) |
| Text (facultatif) | `DISCORD_ROLE_ID` | identifiant d'un rôle Discord à mentionner sur les signaux ≥ 90 |

Clique sur **Save / Deploy**.

### 4. Vérifie

- Dans les 5 minutes, le message **« ✅ Crypto Radar connecté »** arrive dans ton salon.
- Tu peux aussi ouvrir l'adresse du worker (`https://crypto-radar-discord.<ton-compte>.workers.dev`). Elle affiche l'état
  de la dernière analyse : sources lues, erreurs, état Discord. Aucun secret n'y apparaît.

### Un salon haussier et un salon baissier (facultatif)

1. Crée deux salons, par exemple `🟢-haussier` et `🔴-baissier`, avec un webhook dans chacun.
2. Mets leurs URL dans `DISCORD_WEBHOOK_BULLISH` et `DISCORD_WEBHOOK_BEARISH`.

Chaque salon reçoit alors un message de bienvenue qui dit ce qu'il va recevoir, puis uniquement ses alertes.
`DISCORD_WEBHOOK_URL` devient facultatif : s'il est rempli, il reçoit ce qui ne va dans aucun des deux salons.

## Problèmes fréquents

| Ce que tu vois | Solution |
|---|---|
| Pas de message après 10 min | ouvre l'adresse du worker et lis `errors` |
| `webhookConfigured: false` | `DISCORD_WEBHOOK_URL` absent ou mal copié (il doit commencer par `https://discord.com/api/webhooks/`) |
| `SITE_URL non configurée` | ajoute `SITE_URL` (sans `/` à la fin, ce n'est pas grave s'il y en a un) |
| Erreurs CoinGecko `(amont 429)` | ajoute la clé CoinGecko **sur le site** (projet Pages), pas sur le worker |
| Erreur de déploiement « name mismatch » | le nom du worker doit être exactement `crypto-radar-discord` |
| Trop de messages | augmente `DISCORD_MIN_STRENGTH` (80 ou 85) |

## Coût et limites

L'offre gratuite de Cloudflare suffit : 288 exécutions par jour, environ 25 requêtes chacune, et un petit stockage
(Durable Object SQLite) pour les délais anti-doublon et l'historique des prix sur 20 min.

Les signaux sont des **informations statistiques, pas des conseils**. Aucun ordre n'est jamais passé.

## Pour les développeurs

- **Code source :** `deploy/discord-worker/src/worker.ts`. Il réutilise `IntelService`, `DiscordNotifier` et le moteur
  du core.
- **Rebundler après une modification :** `pnpm build:worker`. Cela génère `dist/worker.js`, qui est commité.
- **Test local :** `npx wrangler dev --test-scheduled`, lancé depuis `deploy/discord-worker`, puis
  `curl "localhost:8787/__scheduled"`.
- **Tests :** `apps/server/test/discord-worker.test.ts`.
