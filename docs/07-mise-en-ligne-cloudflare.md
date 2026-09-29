# 07 — Mettre le radar en ligne (Cloudflare Pages, gratuit)

Résultat : une adresse du type `https://crypto-radar-xxx.pages.dev`, ouvrable depuis ton téléphone ou n'importe quel
ordinateur, avec les **vraies données** : Binance en temps réel, CoinGecko, DEX et actualités.

## Comment ça marche

```
Ton navigateur ──WebSocket──▶ Binance (prix de toutes les cryptos, en direct)
      │
      ├──▶ /api/coinbase ─┐ (cryptos Coinbase, toutes les minutes)
      ├──▶ /api/cg/…    ─┐
      ├──▶ /api/news/…   ├─ fonctions Cloudflare (dans ce dépôt : deploy/cloudflare/functions)
      └──▶ /api/binance ─┘   → CoinGecko, flux RSS, liste des paires Binance, avec cache partagé
```

- **Le moteur d'analyse tourne dans le navigateur.** Il est identique à celui du serveur local.
- **Les fonctions Cloudflare ne font que relayer** une liste fixe d'adresses, avec un cache :
  - les actualités sont gardées 5 min ;
  - CoinGecko est gardé 30 à 60 min, pour que tous les visiteurs partagent le même quota ;
  - la clé CoinGecko reste secrète chez Cloudflare.
- **Coût : 0 €** avec l'offre gratuite de Cloudflare (Pages + Functions, 100 000 requêtes/jour).

**Limites de ce mode :**
- l'analyse ne tourne que lorsque la page est ouverte ;
- pas d'alertes Discord depuis la page : elles viennent du worker 24 h/24 (voir docs/08) ;
- l'historique (page Performance) reste dans le navigateur utilisé.

## Mise en place pas à pas (≈ 10 minutes)

*Les libellés exacts de l'interface Cloudflare peuvent varier légèrement (ou être en anglais).*

1. **Crée un compte gratuit** sur <https://dash.cloudflare.com/sign-up>.
2. **Relie GitHub à Cloudflare :**
   - dans le menu de gauche : **Workers & Pages** → **Créer** → onglet **Pages** → **Se connecter à Git** ;
   - autorise Cloudflare à accéder à ton dépôt `CryptoScanning` (tu peux ne cocher que ce dépôt).
3. **Paramètres de build** (c'est l'étape importante) :

   | Champ | Valeur |
   |---|---|
   | Nom du projet | `crypto-radar` (il donnera l'adresse `crypto-radar.pages.dev`, ou une variante si le nom est pris) |
   | Branche de production | `claude/coinbase-trading-radar-xbpo4i` (ou `main` une fois fusionnée) |
   | Préréglage du framework | **Aucun** |
   | Commande de build | *laisser vide* |
   | Répertoire de sortie du build | `public` |
   | Répertoire racine (avancé) | `deploy/cloudflare` |

4. Clique sur **Enregistrer et déployer**. Au bout d'environ 1 minute, Cloudflare affiche l'adresse du site.
5. **Recommandé : ta clé CoinGecko gratuite.**
   - Crée-la sur <https://www.coingecko.com/en/developers/dashboard> (plan *Demo*).
   - Dans Cloudflare, ouvre **ton projet → Paramètres → Variables et secrets → Ajouter** :
     - `COINGECKO_API_KEY` = ta clé, type **Secret** (chiffré) ;
     - `COINGECKO_PLAN` = `demo`.
   - Puis **Déploiements → ⋯ → Réessayer le déploiement**, pour que la clé soit prise en compte.

   Sans clé, ça marche aussi, mais CoinGecko limite plus vite les appels venant des serveurs Cloudflare.

6. Ouvre le site. La page **Sources** montre l'état de chaque source.
   - Binance est vert en quelques secondes.
   - CoinGecko et les actus arrivent en 1 à 2 minutes.
   - Les signaux « décollage » et « chute » sur 5 min apparaissent après environ 5 minutes d'historique.

À chaque nouveau commit sur la branche, Cloudflare redéploie automatiquement.

## Qui peut voir le site ?

L'adresse `.pages.dev` est **publique** (non référencée par les moteurs de recherche grâce à `noindex`). Le site n'expose
aucun secret, et les fonctions ne relaient qu'une liste fixe d'adresses : personne ne peut s'en servir pour autre chose.

Pour le réserver à toi, utilise **Cloudflare Access** (gratuit jusqu'à 50 personnes) :

1. Dans le tableau de bord, ouvre **Zero Trust → Access → Applications → Ajouter une application → Self-hosted**.
2. Domaine : `crypto-radar.pages.dev` (ton adresse).
3. Politique : **Autoriser**, règle *Emails* = ton adresse.

Cloudflare demandera alors un code envoyé par e-mail avant d'afficher le site. (Le réglage « Politique d'accès » dans
les paramètres du projet Pages ne protège que les déploiements de prévisualisation, pas l'adresse principale.)

## Si quelque chose ne marche pas

| Symptôme (page Sources) | Cause probable | Solution |
|---|---|---|
| Binance « hors service » | ton réseau ou ton pays bloque Binance | CoinGecko et les actus continuent de fonctionner |
| CoinGecko « dégradée », erreur 429 | trop d'appels sans clé | ajouter `COINGECKO_API_KEY` (étape 5) |
| CoinGecko « clé refusée » / 401 / 403 | clé mal copiée, ou mauvais plan | vérifier la clé et `COINGECKO_PLAN` |
| Un média « erreur » | son flux RSS a changé d'adresse ou bloque Cloudflare | le retirer ou le corriger dans `deploy/cloudflare/lib/proxy.js` |
| Page blanche | le navigateur bloque cdnjs.cloudflare.com (React) | désactiver le bloqueur pour ce site |

## Pour les développeurs

- **Reconstruire la page** après une modification du code : `pnpm build:web`. Cela régénère
  `deploy/cloudflare/public/index.html`, qui est commité pour que Cloudflare n'ait rien à compiler.
- **Tester en local avec le vrai runtime Cloudflare :** `npx wrangler pages dev deploy/cloudflare/public`, lancé depuis
  `deploy/cloudflare`.
- **Tests des fonctions :** `apps/server/test/cloudflare-functions.test.ts`.
