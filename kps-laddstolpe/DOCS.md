# KPs Laddstolpe

Elbilsladdning med spotprisdebitering, körd som ett tillägg på Home Assistant.

**Version 0.3.3 — fas 3: skarp Easee, endast avläsning.**
Nu kan tillägget läsa av din riktiga laddbox. Inga kommandon skickas till den —
det kommer i fas 4.

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
| `mode` | `simulering` | Se nedan. |
| `easee_username` | tomt | E-postadressen till ditt Easee-konto. |
| `easee_password` | tomt | Lösenordet. Maskeras av Home Assistant. |
| `easee_charger_id` | tomt | Laddboxens id, till exempel `EMHDRU5N`. |
| `easee_equalizer_id` | tomt | Frivilligt. Lämna tomt om du saknar Equalizer. |
| `log_level` | info | Sätt `debug` om något krånglar. |

### De tre lägena

| Läge | Betyder |
|---|---|
| `simulering` | Virtuell laddbox. Ingen kontakt med Easee alls. |
| `avlasning` | Riktig Easee, men **enbart läsning**. Inga kommandon skickas. |
| `skarp` | Riktig Easee med kommandon. Låses upp i fas 4. |

**I adminfliken** — ändras ofta, slår igenom direkt: avgifter, strömgräns.

## Grinden för fas 3

Först: **gör fas 2-proven igen i `simulering`** efter uppdateringen, så att
ingenting gått sönder. De står längre ner.

Byt sedan `mode` till `avlasning` och fyll i dina Easee-uppgifter. Fyra prov.

**1. Inloggningen fungerar.** Titta i loggen. Där ska stå
*"[Easee] Inloggad. Token giltig i cirka 24 timmar."* Står det att inloggningen
nekades är e-post eller lösenord fel.

**2. Värdena stämmer.** Adminfliken → **Diagnostik**. Jämför `cableConnected`,
`totalPower` och `sessionEnergy` med vad Easee-appen visar i mobilen. De ska vara
samma. Sitter ingen kabel i ska `chargerOpMode` vara 1.

**3. Inga kommandon slipper igenom.** Gästsidan ska säga *"Avläsningsläge"*
längst ner, och även med kabeln i ska ingen startknapp visas.

**4. Tokenförnyelsen håller ett dygn.** Det här provet tar tid men är det
viktigaste. Låt tillägget rulla ett dygn. Gå sedan till adminfliken →
**Laddbox** och titta på Easee-rutan:

> **Inloggningar ska vara 1.** Tokenförnyelser ska vara 1 eller 2.
> Anrop senaste timmen ska ligga runt 12 i viloläge.

Stiger inloggningarna med tiden är något fel, och då ska vi stanna och rätta det
innan vi går vidare. Den gamla molnappen loggade in **2 880 gånger per
laddningsdygn** — det är precis så man blir IP-spärrad hos Easee, och en spärrad
IP betyder att stolpen slutar svara helt.

## Att läsa lastbalanseringen

Adminfliken → **Diagnostik** → *Lastbalansering* visar det som faktiskt styr hur
snabbt bilen laddar:

| Rad | Betyder |
|---|---|
| Boxen får dra | Vad laddboxen är konfigurerad för |
| Tilldelat just nu | Vad den faktiskt får ta ut i det här ögonblicket |
| Ström L1 / L2 / L3 | Per fas. Ligger en fas nära noll laddar bilen på två faser |
| Ström nolledare | Bär returströmmen vid tvåfasladdning, och kan därför ligga högt även när en fas är tyst |
| Equalizern tillåter | Vad lastbalanseraren släpper fram, per fas |
| Strömbegränsning | Easees egen förklaring, i klartext |

Skillnaden mellan *får dra* och *tilldelat just nu* är lastbalanseringen i en
enda siffra.

## Om du vill se rådata

Adminfliken → **Diagnostik** → *Rå API-inspektör*. Knapparna visar Easees
obearbetade svar för laddarstatus, detaljer, konfiguration, Equalizer och listan
över dina laddboxar. Det är det snabbaste sättet att förstå varför boxen beter
sig som den gör.

## Grinden för fas 2, som referens

Fem prov i `simulering`. Alla görs utan bil och utan laddbox.

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

**Easee-token hanteras varsamt.** En inloggning, sedan förnyelse med
`refresh_token` innan den går ut. Vid 429 eller serverfel backar appen av
exponentiellt, upp till en halvtimme. Loopen pollar var 30:e sekund under
laddning men bara var femte minut i viloläge — glest nog att vara hövlig, tätt
nog att Easees refresh-token inte ska hinna dö av inaktivitet, vilket den gör
om ingen rör kontot på en vecka.

**Tre avläsningstakter.** Var tionde sekund när någon har gästsidan öppen, var
trettionde när en laddning pågår utan publik, var femte minut i viloläge. Att
någon står vid stolpen och tittar är den enda situation där en snabbare
avläsning gör verklig nytta — det är då man vill se effekten ändras när
lastbalanseraren griper in. Aktuell takt syns på adminfliken.

**Siffrorna tickar jämnt.** Mellan två avläsningar räknar webbläsaren vidare
utifrån effekten, så beloppet stiger mjukt i stället för att stå still och sedan
hoppa. Det är enbart för ögat: **det som debiteras är alltid de riktiga
mätvärdena** från laddboxen, aldrig uppskattningen.

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
inte hända — kontrollera att `mode` står på `simulering`. I avläsningsläge
betyder det att Easee inte svarar; titta i loggen och i Easee-rutan under
**Laddbox**.

**"Väntar N sekunder efter tidigare fel mot Easee."** Appen backar av med flit
efter ett misslyckat anrop. Rätta orsaken, starta om tillägget, så nollställs
väntetiden.

**Sessionen avslutas direkt när jag startar.** Kontrollera under **Diagnostik**
att `cableConnected` är `true`.

**Adminfliken är tom.** Slå på *Visa i sidofältet* under tilläggets Info-flik.
