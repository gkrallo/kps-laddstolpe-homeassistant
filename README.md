# KPs Laddstolpe — Home Assistant-tillägg

Elbilsladdning med spotprisdebitering, SMS-kvitto och Swish, körd som ett tillägg
på Home Assistant i stället för i molnet.

## Installera

1. **Inställningar → Tillägg → Tilläggsbutik → ⋮ → Förråd**
2. Klistra in `https://github.com/gkrallo/kps-laddstolpe-homeassistant`
3. **Lägg till**, stäng rutan, och installera tillägget som dyker upp.

## Tillägg

| Tillägg | Version | Status |
|---|---|---|
| [KPs Laddstolpe](./kps-laddstolpe) | 0.2.0 | Fas 2 — backend i simuleringsläge |

## Arkitektur

Två separata webbservrar i samma tillägg, med helt skilda rutt-tabeller:

- **Port 8443 — gästsidan.** Publik, ingen inloggning, HTTPS med Let's Encrypt-
  certifikatet som DuckDNS-tillägget lägger i `/ssl`. Vidarebefordras i routern.
- **Port 8099 — adminfliken.** Nås bara via Home Assistants sidopanel, alltså bara
  av någon som är inloggad i HA. Öppnas aldrig i routern.

Adminvägarna är inte registrerade i den publika servern. Det finns ingen dörr att
dyrka upp.

Inga lösenord eller nycklar ligger i repot — allt sådant matas in i tilläggets
inställningar i Home Assistant.

## Så här är koden upplagd

Hela tillägget ligger i **en enda fil**, `kps-laddstolpe/app.js`. Det är ett
medvetet val: uppdatering sker genom att öppna filen, markera allt, klistra in
den nya versionen och spara. Filen är indelad i tolv numrerade avsnitt med
tydliga rubriker.

Inga npm-beroenden. Bara Nodes inbyggda moduler, inget React, inget byggsteg —
tillägget byggs på sekunder på en Raspberry Pi i stället för minuter.

## Faser

| Fas | Innehåll |
|---|---|
| 1 | Anslutningstest — två lyssnare, certifikat, ingress |
| 2 | Backend i simuleringsläge |
| 3 | Skarp Easee, endast läsning |
| 4 | Kommandon och färdigt gästgränssnitt |
| 5 | SMS, Swish och kvitto |
| 6 | Härdning och HA-sensorer |
| 7 | Parallelldrift och avveckling av molnversionen |
