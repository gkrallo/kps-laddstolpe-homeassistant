# KPs Laddstolpe

Elbilsladdning med spotprisdebitering, körd som ett tillägg på Home Assistant.

**Version 0.2.1 — fas 2: backend i simuleringsläge.**
Ingen kontakt med den riktiga laddboxen ännu. Allt annat är på riktigt:
prishämtning, kvartsvis kostnadsberäkning, bakgrundsloop och lagring.

## Installation

1. **Inställningar → Tillägg → Tilläggsbutik → ⋮ → Förråd**
2. Klistra in `https://github.com/gkrallo/kps-laddstolpe-homeassistant` och klicka **Lägg till**.
3. Stäng rutan. Installera tillägget som dyker upp under **KPs Laddstolpe**.
4. Slå på **Starta vid uppstart**, **Vakthund** och **Visa i sidofältet**.

Låt **Automatisk uppdatering** vara avstängd. Du vill välja själv när en ny fas installeras.

## Inställningar

Två sorters inställningar, medvetet åtskilda.

**Här, under Konfiguration** — ändras nästan aldrig, kräver omstart:

| Alternativ | Standard | Betydelse |
|---|---|---|
| `ssl` | `true` | HTTPS på gästsidan. |
| `certfile` / `keyfile` | `fullchain.pem` / `privkey.pem` | Filer i `/ssl`. DuckDNS-tillägget skapar dem. |
| `location_name` | Gräshagen 4 | Visas på gästsidan. |
| `price_zone` | SE3 | Elprisområde. |
| `simulation` | `true` | Virtuell laddbox. **Låt stå kvar på true i fas 2.** |
| `log_level` | info | Sätt `debug` om något krånglar. |

**I adminfliken** — ändras ofta, slår igenom direkt: avgifter, strömgräns.

## Grinden för fas 2

Fem prov. Alla görs från adminfliken och gästsidan, utan bil och utan laddbox.

**1. Priset hämtas.** Öppna adminfliken → **Priser**. Där ska stå antal kvartar
för idag och gärna även morgondagen (släpps av Nord Pool vid 13–14-tiden).
Rutan längst ner visar vad en kilowattimme kostar just nu.

**2. En laddning från början till slut.** Fliken **Laddbox** → *Sätt i kabeln*.
Gästsidan byter till "Redo att ladda". Skriv ett mobilnummer, tryck *Starta
laddning*. Gå tillbaka till admin → *Spola fram 60 min*. Kostnaden ska ha ökat
och stämma mot priset per kWh gånger antal kWh.

**3. Lastbalanseringen räknas rätt.** Tryck *Strypa till 0 kW* och sedan
*Spola fram 60 min*. **Energin ska stå still och kostnaden ska inte öka** — och
sessionen ska inte avslutas. Det här är hela poängen med appen: en dyr kvart
utan ström ska kosta noll. Tryck sedan *Släpp på effekten* och spola fram igen,
så ska den öka som vanligt.

**4. Omstart mitt i en laddning.** Med en laddning igång: stoppa tillägget och
starta det igen. Loggen ska säga *Återupptar pågående session*, och gästsidan
ska visa samma kilowattimmar och kronor som innan. Ingenting får gå förlorat.

**5. Kabeln dras ur.** Tryck *Dra ur kabeln*. Sessionen avslutas — men först
efter **två** avläsningar i rad, inte den första. På mobilen ska kvittot dyka
upp av sig självt inom några sekunder, med kilowattimmar, elkostnad, avgift och
summa. Trycker du *Klar* och laddar om sidan ska en rad högst upp påminna om att
laddningen är obetald. Kvittot finns också under **Sessioner** i adminfliken.

### Varför två avläsningar och inte en

Det är ingen betänketid för att hinna sätta i kabeln igen — drar man ur är
laddningen slut. Det är ett filter mot en enda felaktig avläsning från Easees
moln, som annars skulle avsluta en pågående laddning i onödan. Det kostar
trettio sekunder och skyddar mot ett fel som är obehagligt att upptäcka i
efterhand.

## Vad som byggts

**Prisberäkningen** följer formeln du valt. Momsen ligger inbakad i
självkostnaden och nämns aldrig, varken i gränssnittet eller på kvittot:

```
pris/kWh = (elbörspris + 0,069 + 0,122 + 0,360) × 1,25 + 0,500
```

Varje kilowattimme prissätts mot den kvart den faktiskt levererades i.
Kvartarna matchas på tidsstämpel, aldrig på position i listan — annars blir
varje pris fel de dygn som har 92 eller 100 kvartar på grund av
sommartidsomställningen.

**Prisdata cachas** på disk med sju dygns historik. Ligger elprisetjustnu.se
nere vid midnatt kan midnattskvarten ändå debiteras rätt. Saknas priset helt
används senast kända värde, sessionen märks som uppskattad, och det står på
kvittot. Appen gissar aldrig tyst.

**Lagringen är byggd för SD-kort.** Aktiv session skrivs som mest varannan
minut, avslutade skrivs en gång till en separat fil. Allt skrivs till en
`.tmp`-fil som byter namn på plats, så ett strömavbrott mitt i en skrivning
aldrig kan förstöra det som redan finns.

**Certifikatet laddas om automatiskt.** Fas 1 läste `/ssl` en enda gång vid
start, vilket betydde att tillägget hade fortsatt servera det gamla certifikatet
efter att DuckDNS förnyat det. Nu kontrolleras filerna varje timme och byts ut i
den igångvarande servern utan omstart.

## Två ingångar

| | Gästsidan | Adminfliken |
|---|---|---|
| Port | 8443, öppen i routern | 8099, endast internt |
| Inloggning | Ingen | Din HA-inloggning, via Ingress |
| Kan ändra inställningar | Nej — rutterna finns inte | Ja |

Adminvägarna registreras aldrig på den publika servern. Det är inte ett lösenord
som skyddar dem; de existerar helt enkelt inte där. Under **Diagnostik** finns
hela listan över vad gästsidan kan svara på, så du kan se det själv.

## Om det inte fungerar

**Inga priser hämtas.** Titta i loggen efter rader om prisfiler. Morgondagens
fil finns inte före ca kl 13 — det är normalt. Saknas även dagens har Pi:n
troligen inte kommit ut på internet.

**Gästsidan säger "Ingen kontakt med laddstolpen".** I simuleringsläge ska det
inte hända. Kontrollera att `simulation` står på `true`.

**Sessionen avslutas direkt när jag startar.** Kontrollera under **Diagnostik**
att `cableConnected` är `true`.

**Adminfliken är tom.** Slå på *Visa i sidofältet* under tilläggets Info-flik.
