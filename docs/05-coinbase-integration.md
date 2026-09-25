# Intégration Coinbase (compte, lecture seule)

## Ce qui est branché

| Endpoint (Advanced Trade v3) | Usage |
|---|---|
| `GET /key_permissions` | permissions de la clé : View / Trade / Transfer, portfolio. **Une clé avec Transfer est refusée** et n'est plus jamais utilisée. |
| `GET /accounts` | soldes du portfolio de la clé (affichés dans Paramètres) |
| `GET /transaction_summary` | **palier de frais réel** (taker / maker), appliqué à la simulation paper quand `paper.feeSource = "account"` (valeur par défaut) |
| `GET /products?get_tradability_status=true` | produits disponibles pour ton compte. Le Risk Engine **refuse** tout produit absent de cette liste. |

La synchronisation a lieu au démarrage, puis toutes les 5 minutes. **Aucun endpoint d'ordre, de conversion ou de transfert n'est appelé**, et un test le vérifie.
Le passage d'ordres réels correspond aux étapes 12-13 (LIVE). Il exige de vérifier la doc officielle des ordres et d'ajouter des confirmations multiples.

## Authentification

Un JWT signé est créé à chaque requête, avec la même structure que le SDK officiel `coinbase-advanced-py` v1.8.4 :

- **En-tête** : `alg` (`ES256` ou `EdDSA`), `typ: JWT`, `kid`, `nonce` (32 octets aléatoires en hexadécimal).
- **Champs** : `sub`, `iss: "cdp"`, `nbf`, `exp = nbf + 120`, `uri = "GET api.coinbase.com/api/v3/brokerage/<chemin>"`.
- **Envoi** : en-tête `Authorization: Bearer <jwt>`.

Signature faite avec `node:crypto`, sans dépendance. Formats de clé acceptés :
- ECDSA P-256 en PEM ;
- Ed25519 en PEM ;
- Ed25519 brute en base64 (format du portail CDP).

**Vérification croisée.** J'ai installé le SDK officiel (depuis PyPI) et fait vérifier mes JWT par PyJWT pour les 3 formats : signatures valides, en-têtes et champs identiques à ceux du SDK.
Ce que je n'ai **pas** pu faire : un appel réel à `api.coinbase.com`, bloqué par le réseau de l'environnement de développement. La première connexion réelle se fera chez toi.

## Mise en place (chez toi)

1. Sur https://portal.cdp.coinbase.com/, crée une clé API **sur un portfolio dédié au bot**, avec la permission **View uniquement** pour l'instant. Surtout pas Transfer.
2. Télécharge le fichier JSON de la clé et range-le **hors du dépôt**, par exemple `~/secrets/cdp_api_key.json`.
3. Dans `.env` : `COINBASE_API_KEY_FILE=/chemin/absolu/cdp_api_key.json` (et `DATA_SOURCE=coinbase` pour les prix réels).
4. `pnpm dev`, puis vérifie dans **Paramètres → Coinbase** :
   - compte connecté ;
   - permissions `View ✓ · Trade ✗ · Transfer ✗` ;
   - palier de frais ;
   - soldes et nombre de produits.

   Le Journal doit montrer « Coinbase connecté en lecture seule ».

## Sécurité

- La clé est lue uniquement par le serveur local. Elle n'apparaît jamais dans le dashboard, l'API ou les logs : seuls les 6 derniers caractères de son nom sont affichés, et le masquage automatique traite les champs `privateKey`, `secret` et `jwt` ainsi que les JWT et les blocs PEM.
- Les messages d'erreur de chargement ne contiennent jamais le contenu de la clé (vérifié par un test).
- Refus automatique de toute clé ayant Transfer. En cas de 401/403, le service s'arrête en erreur, sans relancer en boucle.

## Points non vérifiables d'ici (à confirmer au premier lancement réel)

- La **signification exacte** du champ de tradabilité renvoyé avec `get_tradability_status`. Le radar s'appuie seulement sur la présence du produit dans la liste authentifiée, ce qui est conservateur.
- Le **format du taux de frais**. Je le lis comme une fraction (`"0.006"` = 0,6 %) ; toute valeur hors de [0 ; 5 %] est ignorée.
- La **pagination** de `/products` authentifié, gérée avec la même stratégie défensive que la liste publique.
