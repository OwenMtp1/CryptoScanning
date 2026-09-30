# 09 — Précision des signaux, marchés à levier, réglages Discord

## Ce qui a été ajouté

| Amélioration | Où | Ce que ça change |
|---|---|---|
| **Suivi des résultats 24 h/24** | bot | Chaque alerte est mesurée 15 min, 1 h, 4 h et 24 h après, même site fermé. Page **Performance → Bot 24 h/24**. |
| **Mesure par rapport au Bitcoin** | bot + site | Un +3 % quand le Bitcoin fait +5 % compte comme −2 % : on juge le signal, pas le marché. Case « mesurer par rapport au Bitcoin ». |
| **Force ajustée par les résultats** | bot + site | Dès 20 mesures, un type de signal fiable gagne jusqu'à +30 % de force, un type peu fiable perd jusqu'à −30 %. La raison est écrite dans le signal, et Discord affiche « x % de réussite à 1 h ». |
| **Seuils propres à chaque crypto** | bot + site | Un mouvement doit dépasser 4× le mouvement habituel de la crypto sur 5 min (appris en continu), jamais moins de la moitié des seuils fixes. Le Bitcoin alerte donc plus tôt, les memecoins moins souvent pour rien. |
| **Nouveaux listings** | bot | Toute nouvelle paire ou nouvelle crypto sur Coinbase ou Binance → « 🆕 X arrive sur Coinbase ». |
| **Flux acheteurs / vendeurs** | bot | Pour les cryptos qui bougent sur Binance, part des achats agressifs sur les 5 dernières minutes. Une hausse sans acheteurs est signalée comme fragile. |
| **Filtres anti-pièges** | bot + site | Stablecoins et jetons « enveloppés » (WBTC, stETH…) ignorés ; élan qui s'essouffle signalé ; mouvement confirmé ou contredit sur 1 h. |
| **Contexte de marché** | bot + site | Si le Bitcoin bouge de plus de 1,5 % en 1 h, les signaux à contre-courant sont affaiblis (−20 %) et les autres renforcés (+10 %). Bandeau en haut du Flux. |
| **Liquidations** | site | Liquidations Binance Futures en direct : grosses cascades de positions longues ou courtes (≥ 500 k$ en 5 min). |
| **Long / short ratio** | bot | Ratio comptes long / short (Binance Futures) pour les 15 plus gros marchés à levier. |
| **Buzz Reddit** | bot + site | Mentions d'une crypto dans les nouveaux posts de 4 subreddits, comparées à son habitude. |
| **Page Levier** | site (données du bot) | Contrats perpétuels Coinbase : levier max, funding, mouvements anormaux et indication LONG / SHORT / NEUTRE avec toutes les raisons. |
| **Panneau Discord** | site | Choisis ce qui part sur Discord : force, fiabilité minimale, sens, sources, types de signaux, cryptos incluses ou exclues, pause. |

### L'indication LONG / SHORT (page Levier)

C'est un **score de −100 à +100**, calculé avec des règles fixes et entièrement expliqué :

| Élément | Effet sur le score |
|---|---|
| Élan (15 min, 1 h) | jusqu'à ±30 |
| Achats agressifs | jusqu'à ±20 |
| Funding extrême | lecture à contre-courant : ±15 |
| Ratio long/short extrême | lecture à contre-courant : ±12 |
| Open interest (≥ 5 %) avec le sens du prix | ±10 |
| Signaux récents sur la crypto | jusqu'à ±25 |
| Bitcoin | jusqu'à ±10 |

- Score **≥ +25** → LONG, **≤ −25** → SHORT, entre les deux → NEUTRE.
- Au-delà de **±40**, une alerte part sur Discord (« indication LONG / SHORT »), une seule fois par changement.
- La colonne **« Liquidation au max »** donne le mouvement qui liquide une position au levier maximal (100 / levier).

⚠️ **Ce n'est pas un conseil.** Le levier multiplie les pertes. À ×20, un mouvement de 5 % contre toi fait tout perdre.

**Coinbase Wallet** ne publie pas d'API pour ses marchés à levier. La page utilise donc les **contrats perpétuels officiels de
Coinbase**, avec le levier maximal indiqué par Coinbase. Les marchés affichés dépendent de ce que Coinbase propose dans
ton pays.

## Ce qui n'a pas été fait, et pourquoi

| Idée | Raison |
|---|---|
| Calendrier des déblocages de jetons | Aucune source gratuite et fiable : Token Unlocks, CryptoRank et DefiLlama Pro sont payants. |
| Mouvements des « baleines » | Whale Alert est payant. |
| X (Twitter) | L'accès à l'API de X est payant. Reddit est utilisé à la place. |
| Détection des faux volumes | Il faudrait les ordres un par un sur chaque plateforme : trop lourd pour l'offre gratuite. Le filtre « hausse sans acheteurs agressifs » couvre une partie du problème. |
| Liquidations côté bot (page fermée) | Binance ne les publie que par WebSocket, que le bot (appelé toutes les 20 s) ne peut pas garder ouvert. Elles sont détectées quand le site est ouvert et relayées sur Discord. |

## Ce qu'il faut ajouter de ton côté

### Cloudflare — worker `crypto-radar-discord`

Settings → Variables and Secrets :

| Type | Nom | Obligatoire ? | Valeur |
|---|---|---|---|
| Secret | `RELAY_KEY` | **oui** (pour le relais et le panneau Discord) | ton code de relais (déjà fait si le relais marche) |
| Secret | `DISCORD_WEBHOOK_LEVERAGE` | facultatif | webhook d'un salon « levier » (indications long/short et liquidations) |
| Secret | `DISCORD_WEBHOOK_NEUTRAL` | facultatif | webhook d'un salon « neutre » (signaux sans sens clair). Sans lui, les neutres vont dans les salons haussier **et** baissier. |
| — | `DISCORD_MIN_STRENGTH` | à **supprimer** si elle existe | le seuil se règle maintenant dans le panneau Discord du site |

Rien d'autre à faire : le déploiement est automatique à chaque mise à jour du dépôt.

### Cloudflare — projet Pages (le site)

| Type | Nom | Valeur |
|---|---|---|
| Text | `DISCORD_WORKER_URL` | `https://crypto-radar-discord.<ton-compte>.workers.dev` (déjà fait si la ligne Discord est verte) |
| Secret | `COINGECKO_API_KEY` | ta clé Demo (déjà fait) |

### Discord (facultatif)

1. Crée un salon, par exemple `⚖️-levier`.
2. ⚙️ **Modifier le salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL**.
3. Colle l'URL dans `DISCORD_WEBHOOK_LEVERAGE`, sur le **worker**.

Au passage suivant, le salon reçoit un message de bienvenue, puis les indications long/short et les liquidations. Ces alertes
ne vont alors plus dans les salons haussier et baissier.

### Sur le site

1. **Sources → carte Discord** : ton code de relais doit être « activé » sur ce navigateur.
2. **Discord** (nouvelle page) : règle ce que tu veux recevoir, puis **Enregistrer**. Le bot applique les réglages
   immédiatement. Les signaux écartés restent visibles sur le site.
3. **Performance → Bot 24 h/24** : les statistiques apparaissent au fil des heures. Il faut environ 20 mesures par type de
   signal avant que la force ne s'ajuste toute seule.

## Points à vérifier chez toi (non testables depuis l'environnement de développement)

- **Liquidations :** Binance a réorganisé ses adresses WebSocket Futures en 2026 (`/public`, `/market`, `/private`). Le site
  essaie `/market` puis `/public`. S'il ne reçoit rien pendant 90 s, il passe à l'adresse suivante.
- **Reddit :** Reddit refuse parfois les serveurs Cloudflare. Si les 4 flux « r/… » sont en erreur dans Sources, le buzz Reddit
  ne fonctionnera pas ; le reste n'est pas affecté.
- **Long/short Binance (`fapi.binance.com`) :** s'il est refusé depuis le serveur européen du bot, le bot met cette source en
  pause 30 min et continue sans elle.
- **Unité du funding Coinbase :** l'API donne une fraction, affichée en % (×100), comme pour CoinGecko.
