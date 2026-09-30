# Courbes, setups de trader, réglages du levier, mobile et audit

## 1. Tout part sur Discord, depuis toutes les sources

Avant, deux sources qui voyaient le même mouvement (par exemple Binance puis Coinbase) se bloquaient l'une l'autre.
Désormais :

- **Anti-doublon par source.** Il se fait par `crypto × type × source`. Chaque source envoie donc son alerte :
  Binance, Coinbase, autres plateformes, CoinGecko, actualités, Reddit, levier et setups.
- **OKX, KuCoin et MEXC.** Ils sont lus par le bot, pour les cryptos absentes de Binance et de Coinbase.
- **Sur le site.** Il affiche ses propres signaux et aussi ceux du bot (marqués « détecté par le bot 24 h/24 »).

## 2. Réglages du levier (page Discord)

Un second panneau, « Ce que le bot envoie sur le levier », règle ce qui part dans le salon levier. Il est enregistré
avec le même bouton et protégé par le code de relais. Les réglages disponibles :

- **Indications.** Envoi on/off et score minimal (5 à 100).
- **Sens.** LONG et/ou SHORT.
- **Marchés.** Levier maximal proposé au minimum, plateformes (Coinbase International, INTX, Binance Futures),
  cryptos incluses ou exclues.
- **Renvois.** Nouvel envoi quand le score se renforce de N points ; rappel au bout de N heures si la lecture ne
  change pas.
- **Liquidations.** Vagues de liquidations on/off, avec un montant minimal sur 5 min.

## 3. Page « Courbe »

- Choisis une crypto, puis une période : 1 h, 1 jour, 1 semaine, 1 mois ou 1 an. Les bougies viennent de Binance ;
  Coinbase prend le relais si la crypto n'est pas sur Binance. Ton navigateur les lit directement.
- Un réticule avec une infobulle affiche le prix, l'heure, O/H/B et la variation depuis le début.
- **« Afficher les leviers ».** L'option montre :
  - les marchés perpétuels de la crypto (plateforme, levier maximal, financement, lecture LONG/SHORT) ;
  - les lignes de liquidation long et short sur la courbe, pour le levier et le prix d'entrée choisis ;
  - un tableau des possibilités par levier : prix de liquidation, écart, et gain ou perte sur la mise pour ±1, 2, 5
    et 10 %.
- **« Afficher le setup trader ».** L'option trace la zone d'entrée, le stop et les objectifs, et donne la checklist
  complète et un calculateur de taille de position.
- Lien direct : `#courbe?coin=SOL`.

Les prix de liquidation sont approximatifs : marge isolée, marge de maintenance d'environ 0,5 %, sans frais ni
financement. Vérifie toujours sur la plateforme.

## 4. Le système « comme un trader » (`packages/core/src/intel/setup.ts`)

C'est une checklist transparente, règle par règle, calquée sur la manière dont les traders décident où mettre leur
argent :

| Facteur | Poids | Ce qui est mesuré |
|---|---|---|
| Tendance 1 h | 25 | empilement des moyennes 20 / 50 / 200, pente de la 50 |
| Tendance de fond 4 h | 15 | même chose en 4 h |
| Momentum | 15 | RSI 14 (pénalité en suracheté ou survendu), histogramme MACD et son accélération |
| Structure | 15 | cassure du plus haut ou plus bas des 20 bougies (avec volume), repli sur support ou rejet sous résistance |
| Volume | 10 | pente de l'OBV, volume relatif |
| Positionnement | 10 | financement, ratio long/short, intérêt ouvert, lus **à contre-courant** (foule trop acheteuse = risque de purge) |
| Régime Bitcoin | 10 | tendance du BTC (ignorée pour le BTC lui-même) |

Chaque analyse produit :

- **Une décision.** Un score de −100 à +100 et une décision : **LONG**, **SHORT** ou **ATTENDRE**. On attend si
  |score| < 35, si le trade va contre la tendance 1 h ou 4 h, ou si le gain/risque est inférieur à 1,5.
- **Le plan.**
  - Zone d'entrée : sans courir après le prix (jusqu'à 0,5 ATR ou la moyenne 20).
  - Stop : derrière le niveau le plus proche, entre 1 et 3 ATR.
  - Objectifs : 1,5 R et 3 R, plafonnés par le prochain niveau.
  - Gain/risque, conditions d'invalidation et taille de position pour un risque de X % du capital.
  - **Levier raisonnable maximal** : celui dont la liquidation reste 1,5 fois au-delà du stop, plafonné à ×10.
- **Un indice de confiance** (0 à 100). Il mesure l'accord des facteurs entre eux. Ce n'est **pas** une probabilité
  de gain.

Qui fait tourner l'analyse :

- **Le bot**, 24 h/24, sur environ 60 cryptos à tour de rôle : celles qui bougent, les marchés à levier et les plus
  échangées.
- **Le site**, une crypto toutes les 3 s au démarrage, puis toutes les 10 s.

Un setup LONG ou SHORT devient un signal `SETUP_LONG` ou `SETUP_SHORT`, source « Setup ». Il est envoyé **une fois
par sens** et rappelé au bout de 12 h s'il est toujours valable. Le bot écarte les doublons venant du site. La page
**Setups** liste tout, avec un lien vers la courbe.

## 5. Version mobile

- Une barre d'onglets en bas de l'écran : Flux, Setups, Courbe, Levier et « Plus » (Univers, Performance, Discord,
  Sources). L'en-tête est compact.
- Aucune page ne défile à l'horizontale à 390 px, mesuré sur chaque page. Les tableaux larges défilent dans leur
  cadre.
- La courbe est plus basse et ses marges plus fines ; l'infobulle ne sort pas de l'écran.
- Les champs sont en 16 px (pas de zoom automatique sur iPhone), les boutons et cases sont faciles à toucher, et les
  bords arrondis de l'écran (encoche) sont gérés.
- On peut l'ajouter à l'écran d'accueil : « Partager → Sur l'écran d'accueil » sur iPhone, « Installer
  l'application » sur Android.

## 6. Audit rapide : ce qui a été corrigé

| Point | Risque | Correction |
|---|---|---|
| React chargé depuis cdnjs sans contrôle d'intégrité | un CDN compromis exécute du code sur le site (et lit le code de relais) | React est servi par le site (`public/vendor`, fichiers npm officiels) avec `integrity` (SRI) |
| CSP `script-src 'unsafe-inline'` | une injection HTML deviendrait exécutable | CSP stricte : seul le script du site, identifié par son empreinte SHA-256 (recalculée à chaque build), peut s'exécuter ; `object-src 'none'` |
| Liens venant de données externes (actualités, signaux) | lien `javascript:` | seuls les liens `http(s)` sont cliquables (`safeHref`) |
| Taille du corps vérifiée seulement via `Content-Length` | un corps envoyé en morceaux contournait la limite | lecture plafonnée (64 ko relais, 32 ko réglages) |
| Comparaison du code de relais | la durée révélait la longueur du code ; essais rapides | comparaison en temps constant sans fuite de longueur, pause de 400 ms à chaque refus |
| Message d'erreur Discord | pouvait en théorie contenir une URL | les URL sont masquées avant affichage |
| `.dev.vars` (secrets locaux de wrangler) non ignoré par Git | risque de committer un secret en testant en local | ajouté au `.gitignore` |
| En-têtes | — | ajout de HSTS et `Cross-Origin-Opener-Policy` |

Points vérifiés sans problème :

- aucun secret n'est dans le dépôt ;
- les webhooks et la `RELAY_KEY` ne sont jamais renvoyés ni journalisés ;
- les mentions Discord sont désactivées (`allowed_mentions: []`) ;
- les proxys du site n'acceptent qu'une liste fixe d'URL ;
- les réglages sont validés et bornés côté bot ;
- aucune permission de trading ni de retrait n'existe ;
- aucun ordre n'est passé.

## 7. Correctifs suivants

- **Binance sur Discord.** Deux causes ont été corrigées :
  - **Seuil caché.** L'ancienne variable `DISCORD_MIN_STRENGTH` (souvent réglée à 70) filtrait en silence, en plus du
    panneau, tous les signaux plus faibles, dont la plupart de ceux de Binance. Elle est désormais **ignorée** : seule
    la « force minimale » du panneau Discord compte.
  - **Accès refusé.** Binance peut refuser l'adresse Cloudflare du bot. Le bot essaie maintenant 8 accès Binance à tour
    de rôle (`data-api.binance.vision`, `api.binance.com`, `api-gcp`, `api1` à `api4`, `www.binance.com`) et retient
    celui qui répond.
  - **Diagnostic.** La page Discord affiche « Ce que le bot lit en ce moment » : l'accès Binance utilisé ou le motif du
    refus, et les envois des dernières 24 h par source.
- **Page Levier allégée.** Plus de cartes néon :
  - un encadré **« À surveiller »** avec les 6 marchés les plus intéressants (indication LONG / SHORT, ou mouvement
    anormal net) ;
  - le **classement de tous les marchés** en dessous (lecture LONG / SHORT, puis mouvements anormaux), avec filtres et
    recherche.
- **Courbe au clic.** Un clic sur une crypto (Flux, Levier, Univers, Setups…) ouvre sa fiche avec la courbe
  (1 h à 1 an) en haut, et un lien vers la page Courbe complète (leviers, setup).
