# 06 — Flux d'informations multi-sources (toutes les cryptos + Discord)

Objectif : repérer **le plus tôt possible** les cryptos qui s'emballent ou s'effondrent, sur **tout le marché**, en croisant
plusieurs types d'informations, et l'annoncer sur le dashboard et sur Discord.

> ⚠️ Ce sont des **signaux statistiques**, pas des prédictions ni des conseils. Beaucoup de mouvements détectés se
> retournent. La page **Performance** mesure, pour chaque type de signal, ce qui s'est réellement passé ensuite : c'est
> elle qui dit ce qui marche. L'outil ne passe **aucun ordre** et ne demande **aucune clé de trading**.

## 1. Sources

| Source | Ce qu'elle apporte | Clé ? | Fréquence |
|---|---|---|---|
| **Binance** (WebSocket public) | prix de toutes les paires USDT/USDC/FDUSD, variations 5 min / 15 min, volume 1 h vs moyenne | non | temps réel (~1 s) |
| **CoinGecko** `/coins/markets` | les 1 000 plus grosses capitalisations (réglable) : variations 1 h / 24 h / 7 j, volume, capi, record historique | clé Demo gratuite recommandée | selon budget (≈ 30–60 min) |
| **CoinGecko** `/search/trending` | les cryptos les plus recherchées (attention du public) | idem | selon budget |
| **CoinGecko** `/derivatives` | funding et open interest des contrats perpétuels (levier) | idem | selon budget |
| **GeckoTerminal** via CoinGecko `/onchain/...` | pools DEX tendance et nouveaux jetons (toutes blockchains) | idem | selon budget |
| **Flux RSS** (CoinDesk, Cointelegraph, Decrypt, The Block, Bitcoin Magazine, CryptoSlate, Cryptoast, Journal du Coin) | actualités en anglais et en français | non | un flux toutes les ~40 s |
| **Radar Coinbase** (existant) | opportunités/chutes sur les produits Coinbase | non | temps réel, seulement si `DATA_SOURCE=coinbase` |

Quand le radar Coinbase tourne sur le **simulateur**, ses signaux ne sont pas injectés dans le Flux : on ne mélange pas du
faux avec du vrai.

## 2. Signaux détectés

| Type | Sens | Règle (seuils dans `config/intel.json`) |
|---|---|---|
| Décollage / Chute rapide | ▲ / ▼ | ≥ +4 % en 5 min ou +7 % en 15 min (chute : −5 % / −9 %), paires avec ≥ 200 k$ de volume 24 h |
| Volume anormal | selon le prix 1 h | volume de la dernière heure ≥ 4× la moyenne horaire des 24 h |
| Casse plus haut / plus bas 24 h | ▲ / ▼ | prix au-delà du range 24 h avec mouvement 15 min > 1 % |
| Top hausse / Krach 1 h | ▲ / ▼ | ≥ +8 % / ≤ −10 % en 1 h (capi ≥ 1 M$) |
| Volume / capitalisation anormal | selon 24 h | volume 24 h ≥ 60 % de la capitalisation (spéculation intense) |
| Proche du record | ▲ | à moins de 3 % du plus haut historique et en hausse |
| Entrée dans les tendances | ▲ | nouvelle entrée dans le top des recherches CoinGecko |
| Funding extrême | inverse | funding moyen ≥ +0,05 % → risque de purge des longs (▼) ; ≤ −0,05 % → short squeeze possible (▲) |
| Open interest ↑ | selon 24 h | open interest +15 % depuis le relevé précédent |
| Nouveau jeton DEX / Pump DEX / Risque de rug | ▲ / ▲ / ▼ | liquidité, volume 1 h, ratio achats/ventes, âge du pool, signalements GeckoTerminal |
| Actu positive / négative | ▲ / ▼ | mots-clés expliqués (listing, partenariat, hack, poursuites, delisting, déblocage…) en anglais **et** français |
| **CONFLUENCE** | ▲ / ▼ | au moins **2 types d'indices indépendants** dans le même sens en 2 h |

**Force (0–100)** : de combien la mesure dépasse le seuil, réduite quand le marché est peu liquide. Ce n'est pas une
probabilité de gain.

**Confluence** : Binance, Coinbase et CoinGecko voient **le même mouvement de prix** ; ils comptent donc pour une seule
famille (« prix »). Une confluence exige deux familles différentes parmi : prix, attention (tendances), actualités,
dérivés. Les signaux DEX sont exclus (un même symbole peut désigner des jetons différents sur les DEX).

**Anti-doublon** : un même type de signal n'est pas répété pour une crypto pendant 60 min.

## 3. Mesure des résultats (page Performance)

Chaque signal (sauf DEX) est suivi : prix 15 min, 1 h, 4 h et 24 h plus tard, plus le meilleur et le pire mouvement
entre-temps. Un signal est **réussi** si le prix a bougé d'au moins 2 % dans le sens annoncé. Les mesures prises en
retard (application arrêtée) sont marquées « n/m » et exclues. L'historique est sauvegardé dans `data/intel/state.json`.

Conseil : ne te fie à un type de signal qu'après **plusieurs jours** et au moins ~30 mesures, et compare-le au hasard
(sur un marché qui monte, beaucoup de signaux haussiers « réussissent » tout seuls).

## 4. Discord

1. Dans ton serveur Discord : **Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL**.
2. Dans le fichier `.env` à la racine : `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…`
3. Redémarre (`pnpm dev`), puis page **Sources → Envoyer un message de test**.

Fonctionnement :
- signaux de force ≥ 70 (réglable) → message immédiat, groupés par 10 maximum ;
- signaux un peu plus faibles (≥ 55) → **résumé** toutes les 15 min ;
- même crypto dans le même sens : pas plus d'une alerte immédiate par heure (sauf confluence) ;
- au plus 30 messages par heure ; au-delà, tout part dans le résumé ;
- jamais de `@everyone` / `@here`. Optionnel : `discord.mentionRoleId` pour mentionner un rôle sur les signaux ≥ 90 ;
- respect des limites Discord (10 embeds, 6 000 caractères, réponse 429 + `retry_after`).

**L'URL du webhook est un secret** (elle contient un jeton) : elle reste dans `.env`, n'est jamais journalisée (masquée
dans les logs) ni envoyée au dashboard.

## 5. CoinGecko : clé et budget

Sans clé, l'API publique fonctionne mais avec des limites plus strictes et moins fiables. Recommandé : une **clé Demo
gratuite** (compte sur coingecko.com → Developer Dashboard) puis dans `.env` : `COINGECKO_API_KEY=CG-…`.

Le plan Demo donne **10 000 appels par mois** (et 100/min). Le radar planifie ses appels pour tenir jusqu'à la fin du
mois (UTC) : il calcule le rythme autorisé (`reste × 0,9 / heures restantes`) et allonge les intervalles en conséquence
(page Sources → « Budget CoinGecko »). Le compteur est sauvegardé, un redémarrage ne consomme pas de quota en plus.
Avec un plan payant : `COINGECKO_PLAN=pro` et `coingecko.monthlyCallBudget` à ajuster.

Binance apporte le temps réel sans quota ; CoinGecko sert à couvrir les cryptos absentes de Binance, les tendances,
les dérivés et les DEX.

## 6. Ce qui a été vérifié dans la documentation officielle

Sources lues : `binance/binance-spot-api-docs`, `coingecko/coingecko-api-oas` (fichier `demo-api.json`),
`discord/discord-api-docs` (dépôts GitHub officiels).

- Binance : domaines « market data only » `data-api.binance.vision` et `data-stream.binance.vision` ; flux combinés
  `/stream?streams=a/b` → `{"stream","data"}` ; `!miniTicker@arr` et `!ticker_1h@arr` (champs `s,c,o,h,l,v,q,E` et
  `P,q`) ; **`!ticker@arr` retiré le 2026-03-26** (non utilisé) ; connexion valable 24 h (rotation à 23 h) ; ping serveur
  toutes les 20 s ; `exchangeInfo` = poids 20.
- CoinGecko : en-tête `x-cg-demo-api-key` (Demo, `api.coingecko.com`) / `x-cg-pro-api-key` (`pro-api.coingecko.com`) ;
  `/coins/markets` avec `per_page ≤ 250` et `price_change_percentage=1h,24h,7d` ; formes de `/search/trending`,
  `/derivatives`, `/onchain/networks/trending_pools` et `/new_pools` (`include=base_token`). Les schémas Zod ont été
  validés sur les exemples officiels.
- Discord : `POST /webhooks/{id}/{token}`, `?wait=true`, limites de taille, 429 + `retry_after`, `allowed_mentions`.

## 7. Points ambigus / à confirmer chez toi

L'environnement de développement n'a pas accès à ces services : **aucun appel réel n'a pu être testé ici**. Tout est
validé défensivement (Zod, lignes invalides ignorées, erreurs visibles dans la page Sources).

1. **Unité du funding CoinGecko** : la doc donne un exemple (`0.004308`) sans préciser s'il s'agit de pourcents ou d'une
   fraction. Le radar l'interprète **en %** (cohérent avec les valeurs usuelles ≈ 0,01 % par 8 h). Si les signaux
   « funding extrême » te semblent absents ou omniprésents, ajuste `coingecko.fundingExtremePct`.
2. **Adresses RSS** : non vérifiables d'ici. Un flux qui répond mal apparaît en « erreur » dans Sources ; corrige ou
   retire-le dans `config/intel.json` (`news.feeds`).
3. **Accès Binance selon le pays** : certains pays bloquent Binance ; la source apparaît alors « hors service ».
   Désactivable avec `binance.enabled: false`.
4. **Symboles ambigus** : plusieurs jetons peuvent partager un ticker. On garde le mieux classé ; pour les actus, les
   mots courants (`ONE`, `NEAR` en minuscules…) ne sont reconnus qu'avec `$` ou le nom complet.

## 8. Configuration

Copie `config/intel.example.json` en `config/intel.json` et modifie ce qui t'intéresse (toute clé absente garde sa valeur
par défaut ; un fichier invalide bloque le démarrage avec un message clair). Variables d'environnement : voir
`.env.example` (section « Flux d'informations »).

## 9. Démo

La démo en ligne fait tourner **le même moteur** dans le navigateur avec des sources **simulées** (320 cryptos fictives
ou aux prix fictifs, titres d'actualité marqués `[SIMULÉ]`, pools DEX inventés) et rejoue 3 heures simulées au démarrage
pour que le Flux et la page Performance ne soient pas vides. Rien n'y est réel et Discord n'y est pas connecté.
