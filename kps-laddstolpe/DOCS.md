# KPs Laddstolpe

Elbilsladdning med spotprisdebitering, körd som ett tillägg på Home Assistant.

**Version 0.9.2.** Hela gästflödet är på plats: låst stolpe, nummer bekräftat
med SMS, laddning som lever tills kabeln dras ur, priskurva, kvitto med
Swish-QR, fri laddning för familjen, appen på hemskärmen och schemalagd start.

## Installation

1. **Inställningar → Tillägg → Tilläggsbutik → ⋮ → Förråd**
2. Klistra in `https://github.com/gkrallo/kps-laddstolpe-homeassistant` och klicka **Lägg till**.
3. Stäng rutan. Installera tillägget som dyker upp under **KPs Laddstolpe**.
4. Slå på **Starta vid uppstart**, **Vakthund** och **Visa i sidofältet**.

Låt **Automatisk uppdatering** vara avstängd. Du vill välja själv när en ny
version installeras.

En ny version syns i Home Assistant först när raden `version:` i `config.yaml`
har ändrats. HA tittar bara på den raden — byter du bara ut `app.js` händer
ingenting.

## Inställningar

Två sorters inställningar, medvetet åtskilda. Blandar man ihop dem får man
antingen omstart vid varje avgiftsändring, eller hemligheter som ligger utanför
Home Assistants säkerhetskopiering.

### Under Konfiguration — ändras nästan aldrig, kräver omstart

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
| `sms_username` | tomt | API-användare hos 46elks. |
| `sms_password` | tomt | API-lösenord. Maskeras av Home Assistant. |
| `sms_sender` | KPsLadd | Avsändarnamn, max 11 tecken. |
| `swish_number` | tomt | Ditt Swish-nummer. |
| `swish_name` | tomt | Frivilligt, visas på kvittot. |
| `public_host` | tomt | **Viktig.** `https://grashagen4.duckdns.org:8443` — utan den saknas kvittolänken i SMS:et. |
| `log_level` | info | Sätt `debug` om något krånglar. |

### De tre lägena

| Läge | Betyder |
|---|---|
| `simulering` | Virtuell laddbox. Ingen kontakt med Easee alls. |
| `avlasning` | Riktig Easee, men **enbart läsning**. Inga kommandon skickas. |
| `skarp` | Riktig Easee med kommandon. |

Går något oväntat i skarpt läge: byt tillbaka till `avlasning`. Då slutar appen
omedelbart skicka kommandon, utan att du behöver avinstallera något.

### I adminfliken — ändras ofta, slår igenom direkt

| Inställning | Standard | Var | Betydelse |
|---|---|---|---|
| Elhandelspåslag | 0,069 kr/kWh | Priser | Din självkostnad. |
| Rörlig nätavgift | 0,122 kr/kWh | Priser | Din självkostnad. |
| Energiskatt | 0,360 kr/kWh | Priser | Din självkostnad. |
| Avgift för stolpen | 0,500 kr/kWh | Priser | Ditt påslag, egen rad på kvittot. |
| Maxström | 16 A | Laddbox | Skickas till boxen. |
| Ström vid tappad kontakt | 12 A | Laddbox | Vad boxen får dra om den tappar molnet. |
| Låset på stolpen | på | Laddbox | Stänger av stolpen när ingen laddar. |
| Kabellås under laddning | av | Laddbox | Av som standard — boxar med permanent kabellås sköter det själva. |
| Kräv verifiering | på | SMS | Stäng bara av vid felsökning. |
| Notiser i Home Assistant | `persistent_notification.create` | SMS | Vart larm om schemalagd start går. En tjänst per rad. Se *Schemalagd start* nedan. |
| Startförsök per timme och avsändare | 15 | SMS | Hela hushållet delar IP bakom hemmaroutern. |
| Fria nummer | tom lista | SMS | Familjen. Se *Fri laddning* nedan. |
| Kom ihåg telefoner | på | SMS | Se *Ihågkomna telefoner* nedan. |
| SMS-läge | simulerat | SMS | Se *SMS-lägena* nedan. |
| Vitlista | tom lista | SMS | Gäller i läget *Bara mina nummer*. |
| SMS per dygn / per nummer och timme / per IP och timme | 40 / 3 / 5 | SMS | Tak, så att ett fel inte kan kosta pengar. |

## Så fungerar en laddning

### Låset

Stolpen står avstängd när ingen laddar. Det är det som hindrar någon från att
koppla in sig utan att gå via appen — Easee vägrar helt enkelt ge ström. Appen
slår på laddaren när någon startar och stänger av den igen efteråt.

Vill du ladda din egen bil utan appen: tryck *Lås upp stolpen* i adminfliken,
ladda via Easee-appen, och tryck *Lås stolpen* efteråt. Under **Diagnostik**
visar raden *Stolpen* om den är avstängd just nu.

### Numret

Gästen skriver sitt mobilnummer, får en fyrsiffrig kod i ett SMS och skriver in
den. SMS:et innehåller också en länk som startar direkt. Numret är ett bevis,
inte ett textfält — det är det som gör laddningen spårbar.

Koden är bunden till kabeln. Dras kabeln ur och sätts i igen efter att koden
begärts vägrar länken starta. Det är skyddet mot att starta laddning på fel bil.

### Sessionens tre lägen

```
CHARGING  →  FINISHED  →  COMPLETED
laddar       bilen klar,   kabeln urdragen,
             kabeln kvar   kvitto skickat
```

**Sessionen slutar inte när bilen blir full. Den slutar när kabeln dras ur.**
Däremellan står det *"Bilen är klar"* med mängd och belopp: den som laddat ser
att det är färdigt, den som kommer gående ser att stolpen är upptagen men blir
ledig så fort bilen flyttas.

Vaknar bilen igen — batterivård, förvärmning — går sessionen tillbaka till
*Laddar* av sig själv, och den strömmen hamnar på rätt räkning.

**Kvitto-SMS:et kommer vid urdragning**, inte när bilen blir full. Annars kom
räkningen mitt i natten medan bilen stod kvar till morgonen.

### Hur "klar" upptäcks

Easee rapporterar driftläge 4 när bilen slutat ta emot ström. Det räcker med att
det står sig i **nittio sekunder**. Men läge 4 heter "Completed" hos Easee och
betyder *bilen har pausat eller slutat ladda* — inte nödvändigtvis full. Och
läge 2 rymmer både en färdig bil och en bil som står i kö bakom
lastbalanseringen.

Därför spärren: **stryper Equalizern är laddningen inte klar**, hur länge
effekten än legat på noll. De vaga lägena får vänta ut tjugo minuter i stället.
Att vara snabb är ofarligt — en förhastad slutsats avslutar ingenting, den
rättar bara sig själv om bilen fortsätter.

### Ägarskap

Telefonen som laddar får betallänken och knappen *Avsluta laddning*. En
förbipasserande ser att stolpen används, hur mycket som laddats och att den blir
ledig när kabeln dras ur — men kan varken komma åt räkningen eller avbryta
grannens laddning. Det gäller både i gränssnittet och i servern.

Tre vägar leder fram till att appen vet att laddningen är din:

| Väg | När |
|---|---|
| Kvittonyckeln | Du tryckte på startknappen, eller kom in via länken i SMS:et. Nyckeln plockas bort ur adressraden direkt så att den inte följer med om sidan delas. |
| Numret | Telefonen är ihågkommen och laddningen går på samma nummer. Gäller även om just den webbläsaren aldrig sett kvittonyckeln. |
| Koden du bad om | Sidan bad om en kod och du tryckte på länken i stället för att skriva in den. Sidan frågar då servern om dess kod startade något, och hämtar hem laddningen. |

**Varför tre.** På en iPhone har hemskärmsappen och Safari varsitt eget lager —
de delar ingenting. En länk i ett SMS öppnas alltid i Safari, så startar du den
vägen hamnar kvittonyckeln där och appen på hemskärmen vet ingenting om den. De
två andra vägarna finns för att appen ska hitta hem ändå. På Android delar
Chrome och hemskärmsappen samma lager, så där räcker den första.

Följden är att samma telefon kan stå två gånger i listan över ihågkomna
telefoner, en gång per webbläsare. Det är avsiktligt: nycklarna går inte att
flytta mellan lagren.

## Schemalagd start

Är telefonen ihågkommen står det **Starta senare…** under startknappen. Välj ett
klockslag — förslaget är den billigaste kvarten framåt — och boka. Stolpen är
sedan reserverad tills dess.

Har klockslaget redan passerat i dag menas i morgon, så "02:15" fungerar när man
står där klockan elva på kvällen.

> Schemaläggning kräver att telefonen bekräftat sitt nummer minst en gång. Den
> som laddar en enda gång möter exakt samma sida som förut.

### Vad du ser under tiden

| Vem | Vad |
|---|---|
| Du som bokade | *"Laddningen börjar 02:15"* med nedräkning, och knapparna *Starta nu i stället* och *Avbryt schemat*. |
| En förbipasserande | *"Stolpen är reserverad"* och när den börjar. Inga knappar — en reservation som går att äta upp är ingen reservation. |

### Vad som kan gå fel, och vad som händer då

Det svåra är inte att räkna ut när klockan är 02:15. Det svåra är att löftet ska
hålla trots att allt däremellan kan ändra sig. **Ett schema som tyst uteblir är
värre än inget schema** — man sover och tror att bilen laddar.

| Vad som händer | Vad appen gör |
|---|---|
| Tillägget startas om, Pi:n bootar | Schemat ligger på disk och läses tillbaka. |
| Kabeln dras ur | Schemat är ogiltigt. **Larm direkt**, inte 02:15. |
| Kabeln dras ur och i igen | Ogiltigt — det kan vara en annan bil nu. Larm. |
| Pi:n var nere när klockan slog | Laddar ändå så fort den kommer upp. Blev det mer än en halvtimme sent får du veta det. |
| Mer än sex timmar sent | Då är det inte en försening längre. Ingen laddning, men besked. |
| Easee svarar inte | Nytt försök varje varv i en halvtimme innan vi ger upp. |
| Bilen vägrar ta emot ström | Samma halvtimme, sedan larm. Vanligaste orsaken är **bilens egen laddtimer**. |
| Klockan hoppar bakåt | Schemat rörs inte det varvet. En Pi utan nät vid boot kan ha vilken tid som helst. |
| Någon annan vill ladda | Nekas så länge reservationen gäller. Du själv får starta direkt. |

Alla larm går som **SMS till den som lade schemat**, och som **notis i Home
Assistant** till dig.

### Notiserna i Home Assistant

Adminfliken → **SMS → Larm om schemalagd start**. **En tjänst per rad**, skriven
som `domän.tjänst`:

| Tjänst | Vad den gör |
|---|---|
| `notify.mobile_app_...` | Push till mobilen. Kräver Home Assistant-appen på telefonen; det exakta namnet står under **Utvecklarverktyg → Åtgärder**, sök på `notify`. |
| `persistent_notification.create` | Hamnar under bjällran i sidopanelen och ligger kvar tills du tar bort den. |
| tomt | Ingen notis. SMS:et går ändå. |

**Ta gärna båda.** De gör olika saker: pushen väcker dig men går att svepa bort
i halvsömnen, den under bjällran finns kvar på morgonen. En tjänst som fallerar
tystar inte de andra.

Knappen **Skicka en testnotis** provar varje väg för sig och säger vilken som
kom fram. Gör det innan du litar på det — bättre att veta nu än 02:15.

Notiserna kräver behörigheten `homeassistant_api`, som lades till i 0.9.0. Har
du uppdaterat men raden **Behörighet** säger att den saknas: starta om
tillägget. Står det *tillgänglig* men notisen ändå inte kommer fram, säger
felmeddelandet vad som är fel — oftast att tjänstenamnet inte finns.

### Att prova det

Lägg ett schema från mobilen. Gå sedan till adminfliken → **Översikt**, där
schemat står, och använd knapparna i schemakortet:

| Knapp | Vad den provar |
|---|---|
| **Förfall om 20 s** | Att laddningen verkligen startar av sig själv. |
| **Som 3 tim försenat** | Försovningen: laddar ändå, och säger till. |
| **Som helt missat** | Bortom sextimmarsgränsen: ingen laddning, bara besked. |

De **fungerar i alla lägen, även skarpt** — de rör bara löftets egen
tidsstämpel, inget kommando går till laddboxen. Det är just i skarpt läge man
vill se sin egen bil starta utan att sitta uppe till klockan två.

## Fri laddning

Adminfliken → **SMS → Fri laddning**. Skriv numren hur du vill: 070-123 45 67
och +46701234567 räknas som samma nummer.

Laddningen registreras ändå, **med den verkliga elkostnaden**, så att du kan se
vad hushållets egen laddning kostar över en månad. Det som uteblir är avgiften
för stolpen, kravet på betalning och kvitto-SMS:et.

De ser priset **utan avgiften** — avgiften är din ersättning för slitage och
meningslös internt. Elkostnaden står kvar, för det är den man behöver för att
avgöra om det är rätt tid att ladda. Priskurvans form är identisk, så rådet om
när man bör ladda är detsamma.

Statusen slås upp vid varje start. Tar du bort ett nummer ur listan börjar det
betala nästa gång. En pågående laddning behåller det den startade med.

## Ihågkomna telefoner

Den som en gång bekräftat sitt nummer med SMS slipper göra om det. Nästa gång
står det *"Vi känner igen den här telefonen"* och en enda knapp. Grannen som
laddar en gång om året möter samma nummerfält som förut.

Nyckeln **sparas aldrig i klartext** — bara en hash, som ett lösenord. Och
nyckeln bär bara *identitet*, alltså vilket nummer telefonen tillhör; om det
numret laddar gratis avgörs separat vid varje start.

Varje telefon syns i adminfliken med när den senast användes, går att namnge
("Emils telefon") och att spärra. En spärr gäller omedelbart. Brytaren för hela
funktionen ligger under **SMS → Ihågkomna telefoner**.

## Appen på hemskärmen

Gästsidan går att lägga till på hemskärmen och beter sig då som en app: eget
fönster utan adressfält, eget kort i appväxlaren, egen ikon och startskärm.

| | |
|---|---|
| **Android, Chrome** | Meny ⋮ → *Lägg till på startskärmen* |
| **iPhone, Safari** | Dela-ikonen → *Lägg till på hemskärmen* |

Det är inte bara utseende. En iPhone raderar allt en vanlig webbsida sparat
efter sju dagars overksamhet — där ligger telefonens minne av vilken laddning
som är dess egen, och nyckeln som gör att den slipper SMS nästa gång. Sidor på
hemskärmen är undantagna. Det är förutsättningen för att "kom ihåg mig" ska
hålla på en iPhone.

**Ingen service worker, medvetet.** Hela appen är ett enda dokument, så det
finns inget skal att spara skilt från logiken — en cache skulle kunna servera en
hel gammal app efter en uppdatering. Priset är att Chrome inte självt föreslår
installation; man får välja det i menyn.

För den som laddar en enda gång ändras ingenting.

## Priskurvan

Längst ned på startsidan, bredvid *Hur räknas priset?*, fälls en kurva ut över
de kommande tolv timmarna — eller så långt elbörsen lämnat priser.

Två linjer, samma axel: **vårt pris** och **elbörsen**. Avståndet mellan dem är
nätavgift, skatt och avgiften för stolpen, och det är hela poängen med att visa
båda. Går elbörsen under noll syns det som en linje under nollstrecket medan
vårt pris ändå ligger över en krona. **Ström är inte gratis för att börspriset
är det.**

Det är en trappa, inte en lutande linje: priset är konstant inom varje kvart och
byter tvärt vid kvartsskiftet. Dra fingret över kurvan så visas priset för den
kvarten. Billigaste kvarten är utmärkt med en punkt och står i klartext under
diagrammet.

Priserna hämtas först när panelen fälls ut.

## Betalningen

| Läge | Vad gästen ser |
|---|---|
| Obetald | *Betala med Swish* — knapp, QR-kod och numret i klartext. |
| Du har markerat betald | Gästen har tryckt *Jag har betalat*. Knappen är borta; betalvägen ligger kvar under *Betala igen om något gick fel*. |
| Betald | Du har bekräftat i adminfliken. Banderollen på startsidan försvinner. |
| Inget att betala | Laddningen slutade på noll kronor. Ingen betalvy visas. |
| Fri laddning | Sammanställning, inte räkning. Ingen Swish, ingen knapp. |

Kvittolänken i SMS:et fungerar **för alltid**. Trycker man på den mitt under
laddningen leder den till laddvyn, inte till kvittot — den som trycker mitt i
vill se hur det går, inte få en räkning för något som inte är klart.

Kvittosidan visar också numrets tidigare laddningar med datum, mängd, belopp och
betalstatus. *Värt att veta: den som får en kvittolänk vidarebefordrad ser också
personens övriga laddningar hos dig. Det är avsiktligt men inte gratis.*

## SMS-lägena

| Läge | Betyder |
|---|---|
| `simulerat` | Inget skickas. Koden hamnar i adminfliken under **SMS → Logg → Visa**. |
| `dryrun` | Anropet byggs och loggas men skickas aldrig till 46elks. |
| `whitelist` | Skickar bara till nummer i vitlistan. |
| `live` | Skarpt. |

Ett SMS som "skickats" är bara ett SMS 46elks tagit emot — leveransen är en
annan sak. Loggraden säger därför *"Lämnat till 46elks"*, och 46elks id och
status står med, så att ett uteblivet SMS går att slå upp i deras panel.

## Så räknas priset

Momsen ligger inbakad i självkostnaden och nämns aldrig, varken i gränssnittet
eller på kvittot:

```
pris/kWh = (elbörspris + 0,069 + 0,122 + 0,360) × 1,25 + 0,500
```

Varje kilowattimme prissätts mot **den kvart den faktiskt levererades i**.
Kvartarna matchas på tidsstämpel, aldrig på position i listan — annars blir
varje pris fel de dygn som har 92 eller 100 kvartar på grund av
sommartidsomställningen.

Energi som mätts upp innan priset finns kastas inte. Den ligger kvar med sin
tidsstämpel och prissätts i efterhand mot sin egen kvart så snart priset kommer.

**Prisdata cachas** på disk med sju dygns historik. Ligger elprisetjustnu.se
nere vid midnatt kan midnattskvarten ändå debiteras rätt. Saknas priset helt
används senast kända värde, sessionen märks som uppskattad, och det står på
kvittot. Appen gissar aldrig tyst.

## Siffrorna på skärmen

Mellan två avläsningar räknar webbläsaren vidare utifrån effekten, så beloppet
stiger mjukt i stället för att stå still och sedan hoppa.

Siffran backar aldrig. Effekten är ett ögonblicksvärde och energin är effekten
summerad över tid, så uppskattningen springer regelbundet förbi mätvärdet —
förut hoppade talet då tillbaka, om och om igen. Nu står den still tills
mätvärdet hunnit ikapp. Hörs inget från laddboxen på nittio sekunder slutar
skärmen räkna vidare helt, i stället för att uppfinna energi utifrån en effekt
vi inte längre vet något om.

**Det som debiteras är alltid de riktiga mätvärdena** från laddboxen, aldrig
uppskattningen.

## Tre avläsningstakter

| Takt | När |
|---|---|
| var 10:e sekund | någon har gästsidan öppen |
| var 30:e sekund | laddning pågår, eller kabeln sitter i, eller kontakten nyss tappats |
| var 5:e minut | viloläge |

Att någon står vid stolpen och tittar är den enda situation där en snabbare
avläsning gör verklig nytta — det är då man vill se effekten ändras när
lastbalanseraren griper in. Aktuell takt syns på adminfliken.

**Easee-token hanteras varsamt.** En inloggning, sedan förnyelse med
`refresh_token` innan den går ut. Vid 429 eller serverfel backar appen av
exponentiellt, upp till en halvtimme. Femminuterstakten i viloläge är glest nog
att vara hövlig, tätt nog att refresh-token inte ska hinna dö av inaktivitet —
vilket den gör om ingen rör kontot på en vecka.

Den gamla molnappen loggade in **2 880 gånger per laddningsdygn**. Det är precis
så man blir IP-spärrad hos Easee, och en spärrad IP betyder att stolpen slutar
svara helt.

## Lagringen

**Byggd för SD-kort.** Aktiv session skrivs som mest varannan minut, avslutade
skrivs en gång till en separat fil. Allt skrivs till en `.tmp`-fil som byter
namn på plats, så att ett strömavbrott mitt i en skrivning aldrig kan förstöra
det som redan finns.

Certifikatet i `/ssl` kontrolleras varje timme och byts ut i den igångvarande
servern utan omstart, så att en förnyelse från DuckDNS slår igenom av sig själv.

## Två ingångar

| | Gästsidan | Adminfliken |
|---|---|---|
| Port | 8443, öppen i routern | 8099, endast internt |
| Inloggning | Ingen | Din HA-inloggning, via Ingress |
| Kan ändra inställningar | Nej — rutterna finns inte | Ja |

Adminvägarna registreras aldrig på den publika servern. Det är inte ett lösenord
som skyddar dem; de existerar helt enkelt inte där. Under **Diagnostik** finns
hela listan över vad gästsidan kan svara på, så du kan se det själv.

## Att läsa lastbalanseringen

Adminfliken → **Diagnostik → Lastbalansering** visar det som faktiskt styr hur
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

Adminfliken → **Diagnostik → Rå API-inspektör**. Knapparna visar Easees
obearbetade svar för laddarstatus, detaljer, konfiguration, Equalizer och listan
över dina laddboxar. Det är det snabbaste sättet att förstå varför boxen beter
sig som den gör.

## Att prova utan att det kostar något

Allt går att prova i `simulering` med `smsMode` på `simulerat`. Koden hamnar då i
adminfliken i stället för i din telefon, och laddboxen är virtuell.

**Grunderna.** Laddbox-fliken → *Sätt i kabeln*. Gästsidan byter till *Redo att
ladda*. Begär en kod, hämta den ur SMS-loggen, starta. *Spola fram 60 min* — och
kontrollera att kostnaden ökat i takt med priset per kWh.

**Lastbalanseringen räknas rätt.** *Strypa till 0 kW*, sedan *Spola fram 60 min*.
Energin ska stå still, kostnaden ska inte öka, och sessionen ska **inte**
avslutas — strypning är inte samma sak som klar. Släpp sedan på effekten igen.

**Klar men kabeln kvar.** Låt simulatorn bli klar. Gästsidan ska säga *Bilen är
klar* — inte *Redo att ladda* — och inget kvitto-SMS ska ha skickats. Dra sedan
ur kabeln: nu kommer kvittot.

**Omstart mitt i en laddning.** Stoppa tillägget och starta det igen. Loggen ska
säga *Återupptar pågående session*, och gästsidan ska visa samma kilowattimmar
och kronor som innan.

**Boxen vägrar stanna.** Tryck *Boxen vägrar stanna* under en laddning och
försök avsluta från mobilen. Appen ska neka och säga att kabeln behöver dras ur.

**Fri laddning.** Lägg ditt eget nummer i *Fria nummer* och ladda. Ingen avgift i
priset, ingen betalvy, inget kvitto-SMS — men laddningen ska ligga under
**Sessioner** med sin verkliga elkostnad.

**Ihågkommen telefon.** Ladda en gång med kod. Dra ur, sätt i, öppna gästsidan
igen: nu ska det stå *Vi känner igen den här telefonen*. Spärra telefonen i
adminfliken och prova igen — då ska nummerfältet vara tillbaka.

**Taken.** Sätt `smsMaxPerDay` till 2 och begär tre koder. Den tredje ska nekas.

**QR-koden.** Det enda som inte går att prova härifrån. Rikta Swish-appen mot
skärmen och se att mottagare, belopp och meddelande blir rätt. **Betala inte** —
kontrollera bara att uppgifterna stämmer, och avbryt.

Först när allt detta stämmer: byt `smsMode` till **Bara mina nummer**, lägg ditt
eget nummer i vitlistan, och gör om koden och kvittot. Då kommer SMS:en på
riktigt, men bara till dig.

### Innan du går skarpt mot Easee

Byt `mode` till `avlasning` och fyll i dina Easee-uppgifter. Loggen ska säga
*"[Easee] Inloggad. Token giltig i cirka 24 timmar."* Jämför sedan
`cableConnected`, `totalPower` och `sessionEnergy` under **Diagnostik** med vad
Easee-appen visar i mobilen.

Låt det rulla ett dygn och titta på Easee-rutan under **Laddbox**:

> **Inloggningar ska vara 1.** Tokenförnyelser 1 eller 2. Anrop senaste timmen
> runt 12 i viloläge.

Stiger inloggningarna med tiden är något fel, och då ska det rättas innan du går
vidare till `skarp`.

## Om det inte fungerar

**Inga priser hämtas.** Titta i loggen efter rader om prisfiler. Morgondagens
fil finns inte före ca kl 13 — det är normalt. Saknas även dagens har Pi:n
troligen inte kommit ut på internet.

**Gästsidan säger "Telefonen når inte appen".** Telefonen fick inget svar från
tillägget. Kontrollera att Pi:n är igång, att porten 8443 fortfarande
vidarebefordras i routern och att certifikatet inte gått ut.

**Gästsidan säger "Ingen kontakt med laddstolpen".** Här svarar tillägget, men
det når inte Easee. I simuleringsläge ska det inte hända. I avläsnings- eller
skarpt läge: titta i loggen och i Easee-rutan under **Laddbox**.

**"Väntar N sekunder efter tidigare fel mot Easee."** Appen backar av med flit
efter ett misslyckat anrop. Rätta orsaken, starta om tillägget, så nollställs
väntetiden.

**Sessionen avslutas direkt när jag startar.** Kontrollera under **Diagnostik**
att `cableConnected` är `true`.

**"För många startförsök."** Taket ligger på 15 per timme och avsändare, och
hela hushållet delar IP bakom hemmaroutern. Höj det under **SMS** om det tar i.

**Gästen kommer inte åt betallänken.** Betallänken går bara till den som laddar.
Har telefonen rensat sitt minne finns länken kvar i kvitto-SMS:et — den fungerar
för alltid.

**Appen på hemskärmen ser laddningen som någon annans.** Ska inte hända längre,
men om det gör det: öppna appen igen efter några sekunder, så hämtar den hem
laddningen. Har den telefonen aldrig bekräftat sitt nummer *inne i appen* finns
inget att känna igen den på — bekräfta en gång där, så gäller det framåt.

**Adminfliken är tom.** Slå på *Visa i sidofältet* under tilläggets Info-flik.

**En laddning ligger kvar som obetald fast den är betald.** Bekräfta den under
**Sessioner** i adminfliken. Det är bekräftelsen som tar bort banderollen hos
gästen.

## Så är koden upplagd

Hela tillägget ligger i **en enda fil**, `app.js`, indelad i tjugoen numrerade
avsnitt med tydliga rubriker. Inga npm-beroenden — bara Nodes inbyggda moduler,
ingen React, inget byggsteg. Tillägget byggs på sekunder på en Raspberry Pi i
stället för minuter.

Inga lösenord eller nycklar ligger i repot. Allt sådant matas in i tilläggets
inställningar i Home Assistant.
