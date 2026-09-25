# Étape 9 — Strategy Builder

Page **Stratégies** du dashboard : créer, modifier, dupliquer, activer ou désactiver, et supprimer des stratégies, sans écrire de code.
L'éditeur reprend la structure de la §20 du cahier des charges :

```
WHEN  [Prix (variation %)] [>] [3] [sur 1m]
AND   [Volume ratio]       [>] [2]
AND   [Score]              [>] [70]
THEN  ouvrir une position de maximum [10 €]
STOP  −[2] % depuis l'entrée (obligatoire)
TRAILING [2] % sous le plus haut · take profit (option) · durée max. (option)
AFTER EXIT  rotation [50 % BTC] [50 % ETH] du [profit | capital récupéré]
```

- Critères disponibles :
  - variation de prix sur 10 s / 30 s / 1 min / 5 min ;
  - volume ratio ;
  - score ;
  - spread ;
  - accélération ;
  - score de liquidité.

  Plus l'univers (devises de cotation, actifs exclus) et le cooldown par produit.
- **Validation instantanée.** Le même schéma Zod tourne dans le navigateur et sur le serveur ; le serveur a le dernier mot.
- **Aperçu en direct**, sans enregistrer : les produits qui remplissent toutes les conditions maintenant, avec le verdict **Risk Engine APPROVED / REJECTED**, et les produits les plus proches, avec l'état ✓ / ✗ de chaque condition.
- Un résumé en clair (« SI … ALORS … ») et les frais aller-retour estimés s'affichent avant chaque enregistrement, avec une demande de confirmation.

## Garde-fous

- **Une stratégie ne peut jamais dépasser le Risk Engine.** Un montant supérieur à `risk.maxTradeQuote` est refusé, et le stop loss est obligatoire.
  Les limites de risque elles-mêmes ne sont **pas** modifiables depuis l'interface : elles se changent seulement dans `config/trading.json`, puis au redémarrage.
- **Les positions ouvertes gardent leurs règles de sortie**, figées à l'entrée. Modifier une stratégie ne touche jamais le stop d'une position existante.
- La **suppression** est refusée tant qu'une position ou un ordre de la stratégie est en cours. Il faut la désactiver et attendre la clôture.
- Chaque changement est journalisé avec l'état avant et après : `STRATEGY_CREATED`, `STRATEGY_UPDATED`, `STRATEGY_DELETED`.
- **Persistance** dans `data/strategies.json`, avec écriture atomique. Quand ce fichier existe, il remplace les stratégies de `config/trading.json`. Un fichier corrompu empêche le démarrage.
- Les routes `POST /api/strategies/*` ont les mêmes protections que l'emergency stop : en-tête dédié, origine autorisée, JSON validé. La suppression exige de taper « DELETE ».

## Tests

- Création, mise à jour et rechargement depuis le fichier ; journalisation de chaque changement.
- **Attaques** : montant supérieur au maximum, absence de stop, identifiant malveillant (`../../etc`).
- Une stratégie désactivée n'ouvre plus rien.
- Les règles d'une position ouverte restent intactes après modification de la stratégie ; la suppression reste bloquée jusqu'à la clôture.
- Aperçu sur marché simulé pendant un pump, sans rien enregistrer ; fichier corrompu refusé.
- Routes de l'API.
- Parcours complet vérifié dans Chromium : création, saisie invalide bloquée, aperçu, enregistrement.

## Suite

Étape 10 : **backtesting**. Rejouer l'historique (bougies publiques Coinbase) à travers le même Strategy Engine, le même Risk Engine et la même exécution paper.
Les résultats seront séparés entre période d'entraînement et période out-of-sample.
