# Ändringslogg

## 0.5.1

Sex fel i kontakten med laddboxen. Tillsammans förklarar de varför det kunde ta
minuter innan skärmen märkte att kabeln satts i, och varför gästsidan kunde stå
kvar på *"Ingen kontakt med laddstolpen"* medan diagnostiken redan visade
kabeln som ansluten.

**Den som står vid stolpen räknas nu som tittare.** Villkoret "någon tittar på
sidan" prövades bara inuti "pågår en laddning?". Alltså gällde den snabba
takten aldrig *innan* laddningen startat — precis i det ögonblick gästen satt i
kabeln och väntade på att skärmen skulle ändra sig. Då gällde vilolägets fem
minuter. Nu prövas det först.

**Och en påbörjad väntan kan avbrytas.** Att gästen öppnade sidan noterades,
men den femminutersväntan som redan var igång löpte klart ändå. Nu kortas den:
är avläsningen äldre än tio sekunder görs en ny nästan direkt. Bara övergången
från "ingen tittade" till "någon tittar" väcker loopen, så en sida som pollar
var femte sekund kan inte framkalla mer än en extra avläsning per minut.

**Ett enda uteblivet svar släcker inte längre gästsidan.** Förut räckte ett
misslyckat anrop för att sidan skulle säga att kontakten var borta, och det satt
kvar tills en avläsning lyckades — i viloläge minst fem minuter bort. Nu visas
det vi senast visste, med åldern utskriven: *"Uppgifterna är avlästa för 40
sekunder sedan."* Larmet kommer först när uppgifterna både hunnit bli gamla och
flera försök i rad misslyckats.

Adminfliken och gästsidan gör numera samma bedömning. Förut läste de olika fält
ur samma ögonblicksbild — gästen tittade på om senaste anropet lyckats,
diagnostiken rakt på värdena — och kunde därför säga emot varandra. Raden
*Läst* har blivit *Värdena avlästa* och *Senaste försök*, som är två skilda
saker, plus takten just nu.

**Väntetiden efter fel är inte längre densamma för allt.** Att Easee svarar 429
betyder "sluta fråga" och ger fortfarande upp till en halvtimme. Att molnet
svarar 502, eller inte hinner svara alls, betyder bara "inte just nu" — taket
för det är två minuter. Förut delade de på halvtimmen, vilket stängde av just
den avläsning som skulle ha visat att felet gått över. Tidsgränsen för ett svar
höjs samtidigt från 15 till 25 sekunder; din box har behövt 17 bara på att
återuppta en laddning, och ett svar på artonde sekunden är inte ett haveri.

**Går avläsningen inte fram vid start används den senaste i stället**, om den är
färskare än halvannan minut. Förut kunde gästen inte starta alls förrän Easee
svarade igen. Startsekvensen kontrollerar ändå efteråt att laddningen kom igång.

**"Ingen kontakt" betyder två olika saker, och sägs nu på två olika sätt.** Att
appen inte når laddboxen, och att telefonen inte når appen, fick samma skärm och
samma text. Den andra säger nu *"Telefonen når inte appen"* och att laddningen
inte påverkas. Ett fel i kvittouppslaget kunde dessutom visa "ingen kontakt med
laddstolpen" trots att statusanropet gått bra; det har egen felhantering nu.

**Energin räknas även när elbörsen är tyst.** Villkoret för att skriva fram
mätvärdet krävde att ett pris fanns. Saknades prisdata stod räknaren stilla,
trots att loggraden lovade motsatsen — och när priserna kom tillbaka
debiterades hela mellanrummet till priset i det ögonblicket i stället för till
priserna som gällde när strömmen faktiskt gick. Nu skrivs mätvärdet alltid
fram, och energi som inte kan prissättas sparas **med tidpunkt** och prissätts i
efterhand mot sin egen kvart. Kostnaden blir densamma som om priserna aldrig
varit borta.

Slår bara till när appen saknar prisdata helt — vanligast strax efter en
nyinstallation, innan första hämtningen lyckats. Går det ändå inte att
prissätta står mängden kvar på kvittot som *inte prissatt*, och summan säger
inte emot sig själv.

**Med `debug` påslaget blir loggen en tidslinje.** Vald takt inför varje varv,
avläsningar som tog mer än fem sekunder, och en rad varje gång boxen faktiskt
ändrar sig. Syns ingen rad när kabeln sätts i har boxen inte berättat det — och
då är det inte appen som sover.

## 0.5.0 — fas 5

SMS, verifiering, Swish och kvittosidan.

**Mobilnumret är ett bevis igen.** Gästen får en fyrsiffrig kod via SMS, plus en
länk som startar laddningen direkt. Länken är bunden till **kabelns löpnummer**,
inte bara till tiden: har kabeln kopplats ur och i igen sedan koden begärdes
händer ingenting. Annars skulle en länk som trycks hemma i soffan kunna starta
laddning på någon annans bil, på fel persons räkning.

**Fyra SMS-lägen**, och läget läses **enbart** ur serverns konfiguration. Den
gamla appen tog emot det från webbläsaren, så en klient kunde tvinga fram
skarpa utskick trots att simulering var påslaget.

| Läge | Skickar | Kostar |
|---|---|---|
| Simulerat | Nej — kod och länk finns i loggen | 0 kr |
| Torrkörning | Nej, men anropar 46elks med `dryrun` | 0 kr |
| Bara mina nummer | Skarpt till vitlistan, simulerat till övriga | Bara dina |
| Skarpt | Ja | Ja |

**Taken gäller i alla lägen, även simulerat.** Ett tak som bara finns i skarpt
läge är ett tak ingen provat. Tak per dygn, per nummer och timme, och per plats
och timme — det sista är kostnadsskyddet nu när gästsidan är publik.

**Teckenräknaren** visar antal delar och varnar för tecken utanför GSM-7. Ett
typografiskt apostrof sänker gränsen från 160 tecken till 70 och tredubblar
kostnaden. Båda mallarna ligger på en del.

**QR-koden genereras i tillägget.** Den gamla appen lät quickchart.io rita den,
vilket innebar att ditt Swish-nummer och exakta belopp skickades till en
främmande webbtjänst varje gång ett kvitto öppnades — och att koden uteblev om
tjänsten låg nere. Nu lämnar ingenting din Pi.

**Kvittosidan** på `/k/<slumpad nyckel>`. Ingen utgångstid, frikopplad från vad
stolpen gör just nu, och den visar Swish-nummer och belopp i klartext som
reserv. En `swish://`-länk gör ingenting alls på en dator eller i en mobil utan
Swish, och misslyckas dessutom tyst.

**"Jag har betalat"** är ett eget tillstånd, skilt från att du bekräftat
betalningen. Appen låtsas inte veta något den inte vet.

## 0.4.3

**Avsluta-knappen sa "Avslutar…" medan laddningen startade.** Gästsidan hade en
enda ja/nej-flagga för "något pågår", så texten på avsluta-knappen ändrades även
när det var starten som var igång. Nu vet sidan vad som faktiskt sker.

**Och starten väntar inte längre ut gästen.** Sekvensen kan ta uppemot en minut
— din box behövde 17 sekunder bara på återupptagningen. Att hålla mobilens
förfrågan öppen så länge är fel: telefonen kan ge upp av sig själv, och under
tiden vet appen inte vad den ska visa. Servern svarar nu direkt när sessionen är
skapad och kör sekvensen vidare i bakgrunden.

Under tiden säger skärmen **"Startar laddningen — det kan ta en halv minut innan
bilen börjar dra ström"**, och avsluta-knappen är avstängd tills laddningen
verkligen är igång. Misslyckas starten får gästen veta det, i stället för att
sitta kvar i en laddvy som aldrig börjar räkna.

## 0.4.2

**Startsekvensen saknades.** Stolpen står avstängd när den inte används — det är
låset som hindrar någon från att bara koppla in sig och ladda gratis. Ett
`start_charging` mot en avstängd laddare kvitteras av Easee utan att något
händer, och boxen svarar med orsakskod 53, *"Laddaren är avstängd"*. Appen
skickade bara startkommandot och undrade varför bilen stod still.

Nu är start en ordning i stället för ett kommando: **slå på laddaren, starta,
och om boxen står och väntar — återuppta.** Bara de steg som behövs, vart och
ett verifierat.

**Och låset sätts tillbaka.** När en laddning avslutas stängs laddaren av igen,
så nästa person måste gå via appen. Brytare i adminfliken under *Låset på
stolpen*, påslagen som standard.

**Manuellt lås.** Knapparna *Lås stolpen* och *Lås upp stolpen* i Laddbox-fliken.

**Diagnostiken visar om stolpen är avstängd**, och simuleringsläget har en knapp
för att stänga av den — så hela startsekvensen går att öva på utan bil.

## 0.4.1

**Adminfliken startade inte i 0.4.0.** Bekräftelserutans radbrytning tolkades en
gång för tidigt: sidan byggs av en textmall, så `\n` blev en verklig radbrytning
mitt i en sträng i webbläsaren i stället för att nå fram som ett tecken. Hela
sidans skript stannade på första raden.

Felet syntes inte i mina kontroller, eftersom `node --check` bara granskar
`app.js` och aldrig den JavaScript som bakas in i sidorna. Kontrollen omfattar
nu båda.

## 0.4.0 — fas 4

Kommandon mot laddboxen. Läget `skarp` gör appen till något som styr hårdvara,
inte bara läser av den.

**Varje kommando verifieras.** Easee svarar 200 så snart molnet tagit emot
kommandot — inte när boxen gjort något. Den gamla appen tolkade det som att
laddningen startat. Nu väntar appen in det observerbara tillståndet: `start`
räknas som lyckat först när driftläget blivit 3 eller effekt börjat flöda,
`stopp` först när driftläget lämnat 3.

**Ett stopp som inte biter avslutar inte sessionen.** Går laddningen inte att
stoppa efter två försök hålls sessionen öppen och fortsätter räknas, och gästen
får beskedet att dra ur kabeln. Alternativet vore att skriva ett kvitto medan
strömmen går — gästen laddar gratis och du betalar.

**Kabellåset lämnas i fred.** Boxar med `lockCablePermanently` sköter det själva.
Måste det slås på finns en brytare i adminfliken, men den är av som standard.

**Kommandologg** i adminfliken: varje kommando med tid, utfall och hur lång tid
bekräftelsen tog.

**Manuell styrning** i Laddbox-fliken, med bekräftelseruta. Start och stopp är
avstängda medan en gästladdning pågår — annars blir kvittot fel.

**"Boxen vägrar stanna"** i simuleringsläget härmar det otäckaste felet, som
inte går att framkalla på riktig hårdvara.

## 0.3.3

**Prickarna är tillbaka.** Å, ä och ö hade fallit bort på flera ställen i
gränssnittet — mitt slarv, jag skrev ASCII i några redigeringar för att undvika
teckenproblem och lämnade kvar det. Rättat i hela appen.

**Strömbegränsningen visas i klartext.** Easees kod översätts nu till svenska:
kod 28 blir *"Begränsad av Equalizern"*. Trettiofyra koder finns med, hämtade
från Easees officiella uppräkning.

**Driftläge 7 och 8** saknades i tabellen och visades som "okänt".

## 0.3.2

**Kabeln lästes av fel mot den riktiga laddboxen.** Specifikationen sa att Easee
returnerar `isCableConnected`. Det gör den inte — fältet saknas helt i svaret
från den här boxen. Följden var att diagnostiken visade `false` mitt under
pågående laddning. I avläsningsläge bara en felaktig rad, men i skarpt läge
hade bakgrundsloopen avslutat varje laddning efter en minut. Kabelns status
läses nu ur driftläget i stället.

**Driftläge 0 avslutar inte längre en laddning.** Läge 0 betyder att boxen
tappat kontakten med molnet och säger ingenting om kabeln. Att avsluta en
session på den grunden vore att straffa gästen för ett nätverksglapp.

**Diagnostiken visar riktiga värden.** Raden för boxens temperatur är borttagen
— Easee rapporterar ingen temperatur. I stället visas fasströmmar, nolledarens
ström, vad Equalizern tillåter, spänning, firmware, felkod och senaste
pulsslag. Saknas ett värde står det streck.

**Lastbalanseringen syns nu i en enda siffra:** skillnaden mellan vad boxen får
dra och vad den tilldelats just nu.

**Ändringslogg tillagd.** Home Assistant varnade för att den saknades.

## 0.3.1

**Tre avläsningstakter.** Var tionde sekund när någon har gästsidan öppen, var
trettionde under laddning utan publik, var femte minut i viloläge.

**Siffrorna tickar jämnt.** Webbläsaren räknar vidare mellan avläsningarna
utifrån effekten. Enbart för ögat — det som debiteras är alltid de riktiga
mätvärdena.

**Dubbla stoppkommandon förhindras.** `endSession` gör ingenting om ingen
session pågår. Harmlöst mot simulatorn, men mot en riktig box är ett upprepat
kommando både bortkastat och en risk.

## 0.3.0 — fas 3

Skarp Easee, endast avläsning.

**Tre lägen** ersätter `simulation`: `simulering`, `avlasning`, `skarp`.

**Easee-klient med varsam tokenhantering.** En inloggning, sedan förnyelse med
`refresh_token`. Token sparas på disk och överlever omstart. Exponentiell
backoff upp till en halvtimme vid 429 och serverfel, aldrig mer än en
inloggning var femte minut.

**Rå API-inspektör** i adminfliken.

## 0.2.1

Kvittot visas av sig självt när laddningen tagit slut, och en rad påminner om
obetalda laddningar. Tidräknaren följer med när man spolar fram tiden i
simuleringsläget.

## 0.2.0 — fas 2

Backend i simuleringsläge. Prishämtning med cache, kvartsvis kostnadsberäkning
enligt prisformeln, bakgrundsloop, sessionslagring byggd för SD-kort,
adminflik med fem flikar och automatisk omladdning av certifikatet.

## 0.1.0 — fas 1

Anslutningstest. Två lyssnare, certifikat från `/ssl`, ingress.
