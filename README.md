# Programmateur ATtiny85 / ATtiny13 en ligne

Programmez un ATtiny85 ou ATtiny13 depuis le navigateur (Chrome / Edge) avec un
Arduino Uno ou Nano en mode ArduinoISP, sans Arduino IDE.

## Fonctionnement

| Partie | Rôle |
|---|---|
| `server.py` | Serveur de compilation : reçoit le code, compile avec arduino-cli, renvoie le `.hex`. |
| `web/stk500.js` | Protocole STK500v1 en JavaScript (Web Serial) : programme l'ATtiny via ArduinoISP, et installe ArduinoISP / le mode normal sur l'Uno ou le Nano via son bootloader. |
| `web/app.js`, `web/index.html` | Interface : choix du port, éditeur, boutons, texte d'aide (référencement Google). |
| `sketches/` | ArduinoISP (mode programmateur) et ModeNormal (programme vide). |

Le serveur n'a **jamais** accès à l'Arduino : c'est le navigateur de l'utilisateur
qui écrit sur le port USB.

## Lancer en local

Double-cliquer `Lancer_programmateur.bat` (ou `python server.py`), puis ouvrir
http://127.0.0.1:8085 dans **Chrome** ou **Edge**. Arduino IDE 2 doit être installé
(son arduino-cli est utilisé), avec les cores ATTinyCore et MicroCore.

## Mettre en ligne (Render, gratuit)

1. Créer un dépôt GitHub contenant ce dossier.
2. Sur https://render.com : **New → Blueprint** → choisir le dépôt (le fichier
   `render.yaml` configure tout). La construction Docker prend ~10 min.
3. Mettre l'adresse finale dans la variable `SITE_URL` (ex. `https://programmateur-attiny.onrender.com`).
4. Référencement Google : https://search.google.com/search-console → ajouter le site →
   envoyer `https://<votre-site>/sitemap.xml`.

Le plan gratuit de Render met le serveur en veille après 15 min sans visite :
la première compilation suivante prend ~1 minute. Un nom de domaine personnalisé
(ex. `attiny-programmateur.fr`) améliore le référencement.

## Variables d'environnement

`PORT` (8080), `HOST` (0.0.0.0), `SITE_URL`, `MAX_PARALLEL` (compilations simultanées, 2),
`RATE_PER_MIN` (compilations par minute et par IP, 20), `ARDUINO_CLI` (chemin de arduino-cli).
