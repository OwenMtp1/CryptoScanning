# 08 — Bot Discord 24 h/24 (Cloudflare Worker, gratuit)

Le site en ligne n'analyse que lorsque la page est ouverte. Ce **worker** tourne en permanence chez Cloudflare, même
quand ton ordinateur et ton téléphone sont éteints :

- **toutes les ~20 secondes** : prix de toutes les cryptos Coinbase, donc alertes décollage et chute presque en direct ;
- **toutes les 5 minutes** : CoinGecko, tendances, dérivés, DEX et actualités ;
- **instantanément**, quand ta page est ouverte : les signaux du site, dont Binance en temps réel (voir « Relais »).

## Ce qu'il surveille

- **Binance** (toutes les 20 s) : toutes les paires, hausses et chutes sur 5 et 15 min, cassures des plus hauts et plus
  bas sur 24 h. Le bot tourne dans un centre de données **en Europe**, parce que Binance refuse les serveurs situés
  aux États-Unis. Si Binance refuse quand même, la page d'état l'indique et le bot réessaie toutes les 30 min.
- **Coinbase** (toutes les 20 s) : les cryptos que Binance n'a pas.
- **CoinGecko** (750 plus grosses capitalisations), toutes les 5 min, via le cache du site : top hausses et krachs sur
  1 h, volumes anormaux, record proche, tendances, funding et open interest (Binance Futures), DEX.
- **Actualités** : 7 médias (CryptoSlate a été retiré, car il refuse les serveurs Cloudflare).
- **Relais du site** : tout ce que le site détecte quand il est ouvert.

## Quelles alertes arrivent ?

- **Tous les signaux, sans seuil, une notification par signal.** Tout ce qui apparaît sur le site part sur Discord.
- **Anti-doublon uniquement :** un même événement (même crypto, même type de signal, même sens) vu à la fois par le site
  et par le bot n'est envoyé qu'une fois en 30 min.
- **Délai :** en temps normal, une alerte part en quelques secondes (relais du site) ou en moins de 20 s (bot).
  Discord limite chaque salon à environ 30 messages par minute. Si le marché s'emballe et qu'une file se forme, le bot
  regroupe temporairement jusqu'à 5 signaux par message pour ne pas prendre de retard.
- **Salons :**
  - les signaux **neutres** (par exemple un volume anormal sans direction) vont dans le salon de `DISCORD_WEBHOOK_NEUTRAL`
    (ou `DISCORD_WEBHOOK_URL`, l'ancien nom, qui marche toujours) ;
  - si tu n'as mis que les salons haussier et baissier, ils vont **dans les deux**, précédés de ⚪.
- `DISCORD_MIN_STRENGTH` est ignorée : le seuil se règle uniquement dans la page Discord du site (« Force minimale »).
- Jamais de `@everyone`.

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
| **Secret** (facultatif) | `RELAY_KEY` | un code que tu inventes (au moins 16 caractères) pour le relais site → Discord |
| — | `DISCORD_MIN_STRENGTH` | ancienne variable, **ignorée** (tu peux la supprimer) | la force minimale se règle dans la page Discord du site |
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

### Relais site → Discord (instantané) et état du bot sur le site

1. **Sur le worker**, ajoute le secret `RELAY_KEY` : un code que tu inventes, par exemple 20 lettres et chiffres au hasard.
2. **Sur le site** (le projet **Pages**), va dans Settings → Variables and Secrets et ajoute
   `DISCORD_WORKER_URL` = l'adresse du bot (`https://crypto-radar-discord.<ton-compte>.workers.dev`). Redéploie ensuite
   le site : Deployments → ⋯ → Retry.
3. **Sur ton site**, page **Sources** → carte Discord : colle le code dans « code de relais » → **Activer**.

Le code n'est gardé que dans ce navigateur. Sur chaque appareil où tu veux relayer, il faut l'entrer une fois.

- **Sans code, ou pendant une coupure :** le site garde les signaux jusqu'à 40 min et les envoie dès que possible. Un envoi
  qui échoue est retenté automatiquement.
- **Suivi :** la carte Discord de la page Sources affiche les signaux transmis, ceux en attente et ceux refusés (avec la
  raison).
- **Indications de levier et signaux du bot :** ils ne dépendent pas du code. Le bot les envoie lui-même, 24 h/24.

Tant que la page est ouverte, ses signaux partent vers Discord en quelques secondes. Ils passent par les mêmes règles
que le bot : seuil, une alerte par heure et par crypto, salons haussier et baissier. Un même mouvement vu par le site et
par le bot n'est donc envoyé qu'une fois. Sans le bon code, personne ne peut écrire dans ton Discord via le site.

## Problèmes fréquents

| Ce que tu vois | Solution |
|---|---|
| Pas de message après 10 min | ouvre l'adresse du worker et lis `errors` |
| `webhookConfigured: false` | `DISCORD_WEBHOOK_URL` absent ou mal copié (il doit commencer par `https://discord.com/api/webhooks/`) |
| `SITE_URL non configurée` | ajoute `SITE_URL` (sans `/` à la fin, ce n'est pas grave s'il y en a un) |
| Erreurs CoinGecko `(amont 429)` | ajoute la clé CoinGecko **sur le site** (projet Pages), pas sur le worker |
| Erreur de déploiement « name mismatch » | le nom du worker doit être exactement `crypto-radar-discord` |
| Trop de messages | monte la « force minimale » dans la page Discord du site (par ex. 60 ou 70) |

## Coût et limites

L'offre gratuite de Cloudflare suffit. Le bot tourne toutes les 20 s (boucle d'alarme du Durable Object, avec la
tâche planifiée toutes les 5 min comme filet de sécurité). Chaque passage fait **au plus 48 requêtes sortantes**,
dont 18 sont gardées pour Discord : Cloudflare en autorise 50 par passage sur l'offre gratuite
([changelog Cloudflare](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/),
[limites des Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits)).

Ce qui est fait à chaque passage :

- Binance, Coinbase et une autre plateforme (OKX, KuCoin et MEXC à tour de rôle) ;
- les setups de trader sur 4 cryptos à tour de rôle (une requête par crypto : bougies 1 h, la vue 4 h est
  recalculée à partir d'elles).

Ce qui est fait une fois toutes les 5 min, réparti sur 3 passages :

- CoinGecko ;
- les actualités et Reddit ;
- les marchés à levier.

Les signaux sont des **informations statistiques, pas des conseils**. Aucun ordre n'est jamais passé.

## Pour les développeurs

- **Code source :** `deploy/discord-worker/src/worker.ts`. Il réutilise `IntelService`, `DiscordNotifier` et le moteur
  du core.
- **Rebundler après une modification :** `pnpm build:worker`. Cela génère `dist/worker.js`, qui est commité.
- **Test local :** `npx wrangler dev --test-scheduled`, lancé depuis `deploy/discord-worker`, puis
  `curl "localhost:8787/__scheduled"`.
- **Tests :** `apps/server/test/discord-worker.test.ts`.
- **Routes publiques en lecture :** `/status`, `/signals`, `/stats`, `/leverage`, `/setups`, `/prefs` (GET).
- **Routes protégées par `RELAY_KEY` :** `/relay`, `/prefs` (POST), `/test-channels`. Une mauvaise clé est refusée
  après une pause de 400 ms. Le corps est limité à 64 ko (relais) et 32 ko (réglages), y compris sans
  `Content-Length`.

## Relais automatique (conseillé)

Ajoute aussi `RELAY_KEY` (même valeur) dans les secrets du **projet Pages** du site. Toute page ouverte du site
relaie alors ses signaux vers Discord sans que tu aies à entrer le code sur chaque appareil. Voir
`docs/10-courbe-setups-mobile-audit.md`, section 16.
