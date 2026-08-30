# Ändringslogg

## 0.8.0 — steg 2 och 3

Familjen slipper krånglet, och grannen märker ingen skillnad.

**Fria nummer.** En lista i adminfliken under *Fri laddning*. Skriv numren hur
du vill — 070-123 45 67 och +46701234567 räknas som samma nummer.

Laddningen registreras ändå, **med den verkliga elkostnaden**, så att du kan se
vad hushållets egen laddning kostar dig över en månad. Det som uteblir är
avgiften för stolpen, kravet på betalning och kvitto-SMS:et. Att skriva noll
kronor och vara klar hade varit enklare, men då kastar man information som inte
går att räkna fram i efterhand — och det var ju din ursprungliga fråga: vad
kostar det egentligen?

**De ser priset utan avgiften.** Avgiften är din ersättning för slitage och
meningslös internt. Elkostnaden står kvar, för det är den man behöver för att
avgöra om det är rätt tid att ladda. Priskurvans **form** är identisk — avgiften
är ett fast påslag per kWh — så rådet om när man bör ladda är detsamma.

**Statusen slås upp vid varje start.** Tar du bort ett nummer ur listan börjar
det betala nästa gång, utan att någon behöver röra deras telefon. En pågående
laddning behåller det den startade med; räkningen ska inte ändra sig under
gästens fötter.

**Ihågkomna telefoner — ett tryck.** Den som en gång bekräftat sitt nummer med
SMS slipper göra om det. Nästa gång står det *"Vi känner igen den här
telefonen"* och en enda knapp. Grannen som laddar en gång om året möter samma
nummerfält som förut.

Nyckeln **sparas aldrig i klartext** — bara en hash, som ett lösenord. Kommer
någon över filen får de inte med sig något som går att använda mot stolpen. Och
nyckeln bär bara *identitet*, alltså vilket nummer telefonen tillhör. Om det
numret laddar gratis avgörs separat, vid varje start.

Varje telefon syns i adminfliken med när den senast användes, går att namnge
("Emils telefon") och att spärra. En spärr gäller omedelbart.

**Tre saker som proven hittade på vägen, alla verkliga:**

*Startspärren kunde nollställas av fel sekvens.* Startade två laddningar tätt
efter varandra kunde den första sekvensens avslut släcka den andras flagga. Nu
har varje sekvens sitt eget tillstånd, och en sekvens som hängt sig i över två
minuter släpper spärren i stället för att låsa stolpen till nästa omstart.

*Startsekvensen malde vidare mot en tom stolpe.* Drog man ur kabeln medan den
väntade in laddboxen fortsatte den i upp till fyrtio sekunder — och under tiden
var stolpen låst för nästa person. Nu avbryts den när kabeln försvinner.

*Taket för startförsök var för snålt.* Fem per timme och avsändare, och hela
hushållet delar IP-adress bakom hemmaroutern — även nekade försök räknades. Nu
femton, och justerbart i adminfliken.

## 0.7.1 — steg 1 av tre

Gästsidan går att lägga till på hemskärmen och beter sig då som en app: eget
fönster utan adressfält, eget kort i appväxlaren, egen ikon och en startskärm i
appens färger.

**Det är inte bara utseende.** En iPhone raderar allt en vanlig webbsida sparat
efter sju dagars overksamhet. Där ligger telefonens minne av *vilken laddning
som är dess egen* — det som avgör om du får betallänken och om skärmen
reagerar när du drar ur kabeln. Sidor som lagts till på hemskärmen är
undantagna från den raderingen. Det här är alltså förutsättningen för att
"kom ihåg mig" ska hålla på en iPhone, vilket kommer i steg 3.

**Så här lägger man till den:**

| | |
|---|---|
| **Android, Chrome** | Meny ⋮ → *Lägg till på startskärmen* |
| **iPhone, Safari** | Dela-ikonen → *Lägg till på hemskärmen* |

För den som laddar en enda gång ändras ingenting. De öppnar länken, gör sitt
och är klara — manifestet är osynligt för dem.

**Ingen service worker, medvetet.** Hela appen är ett enda dokument: HTML, CSS
och all JavaScript i samma svar. Det finns alltså inget "skal" att spara skilt
från logiken, och en cache skulle kunna servera en hel gammal app efter en
uppdatering. Det är precis den sortens fel som är svårast att hitta. Priset är
att Chrome inte självt föreslår installation — man får välja det i menyn.

Ikonerna ligger inbakade i tillägget så att det förblir en enda fil. Bakgrunden
är enfärgad i stället för tonad; en tonad yta komprimeras uselt och gjorde
bilderna sju gånger större utan att synas på en hemskärm.

## 0.7.0

**Elpriset närmaste timmarna.** En ny rad längst ned på startsidan, bredvid
*Hur räknas priset?*, som fälls ut till en kurva över de kommande tolv timmarna
— eller så långt elbörsen lämnat priser.

Två linjer, samma axel: **vårt pris** och **elbörsen**. Avståndet mellan dem är
nätavgift, skatt och avgiften för stolpen, och det är hela poängen med att visa
båda. Går elbörsen under noll — det händer — syns det som en linje under
nollstrecket medan vårt pris ändå ligger över en krona. Ström är inte gratis för
att börspriset är det.

**Det är en trappa, inte en lutande linje.** Priset är konstant inom varje kvart
och byter tvärt vid kvartsskiftet. En linje som lutar mellan punkterna hade
påstått att priset glider däremellan, och då läser man av fel pris för nästan
varje tidpunkt.

**Dra fingret över kurvan** så visas priset för den kvarten, med elbörsens andel
utskriven. Billigaste kvarten är utmärkt med en punkt och står i klartext under
diagrammet.

Färgerna är valda med räknehjälp, inte med ögat: guld och blått ligger 27 steg
isär även för den som har svårt att skilja rött från grönt, och guldet är
nedstämt för att hålla sig i det spann som är läsbart mot mörk bakgrund.
Priserna hämtas först när panelen fälls ut — de skulle annars följt med i varje
statushämtning, var femte sekund, för något man tittar på en gång.

**"Swish och SMS-kvitto kopplas in i fas 5" är borta.** Raden satt kvar på
kvittovyn sedan fas 2, i en app där båda funnits länge. Där står nu en
**Betala med Swish**-knapp och beskedet att kvittot skickats till mobilen.

## 0.6.2

**Siffran gick runt i en cirkel i stället för framåt.** 29,45 · 29,46 · 29,47 ·
29,45 · 29,46 · 29,47 · 29,45 — om och om igen.

Skärmen räknar vidare mellan avläsningarna utifrån effekten, så talen ska ticka
jämnt i stället för att hoppa var tionde sekund. Men effekten är ett
ögonblicksvärde, och energin är effekten summerad över tid. De två går isär:
effekten dippar mellan avläsningarna, lastbalanseringen griper in, och boxens
egen energiräknare uppdateras i steg. Uppskattningen sprang alltså regelbundet
förbi det uppmätta värdet — och när nästa riktiga avläsning kom hoppade talet
tillbaka.

Nu backar siffran aldrig. Ligger uppskattningen före mätvärdet står den still
tills mätvärdet hunnit ikapp, i stället för att räkna baklänges. Energi som gått
genom kabeln kommer inte tillbaka, och en siffra som sjunker får det att se ut
som att appen räknar fel.

**Och gissningen har fått ett tak.** Hörs inget från laddboxen på en och en halv
minut slutar skärmen räkna vidare. Utan tak skulle en tappad förbindelse låta
sidan uppfinna energi på obestämd tid, utifrån en effekt vi inte längre vet
något om.

*Det som visas mellan två avläsningar är fortfarande en uppskattning. Det som
debiteras är alltid de riktiga mätvärdena — det har inte ändrats.*

**Vyn byggdes dessutom om vid varje pollning.** Spärren som skulle hindra det
var felskriven och gällde bara medan någon skrev i ett fält. Var femte sekund
revs alltså hela kortet och byggdes upp igen — vilket bland annat slog igen
*Vad kostar det just nu?* medan man läste det.

## 0.6.1

Appen vet nu vems laddning det är.

**Startade du via länken i SMS:et var telefonen en främling för sin egen
laddning.** Sidan räknade bara den som ägare som tryckt på startknappen i just
den webbläsaren. Gick du in via länken visste den ingenting — och det är därför
ingenting hände på skärmen när du drog ur kabeln, trots att SMS:et kom.
Länken bär nu med sig laddningens nyckel, telefonen sparar den, och nyckeln
plockas bort ur adressraden direkt så den inte följer med om sidan delas.

**Länken under pågående laddning leder till laddvyn**, inte till kvittot. Den
som trycker mitt i laddningen vill se hur det går, inte få en räkning för något
som inte är klart. Är kabeln urdragen är laddningen historia, och då är kvittot
rätt sida. Samma länk, olika svar beroende på var i förloppet du är.

**Och betallänken låg öppen för vem som helst.** Kvittonyckeln följde med i
statussvaret till alla som öppnade gästsidan under en pågående laddning. Med den
kom man åt betalsidan, kunde markera laddningen som betald — och sedan 0.6.0
även se numrets alla tidigare laddningar. Nyckeln skickas nu bara till den som
redan har den, alltså den som laddar.

**Samma sak med avsluta-knappen.** Den visades för alla, och servern frågade
inte vems laddning det var. Vem som helst som kände till adressen kunde avbryta
grannens laddning. Nu kan bara den som startade avsluta, både i gränssnittet och
i servern.

En förbipasserande ser fortfarande att stolpen används, hur mycket som laddats
och att den blir ledig när kabeln dras ur. Det är det som är vitsen med sidan.
Det som försvann var betallänken och möjligheten att gripa in.

## 0.6.0

Sessionen slutar inte längre när bilen blir full. Den slutar när kabeln dras ur.

**Ett nytt läge däremellan: klar, men bilen står kvar.** Förut fanns bara
laddar och avslutad, så i det ögonblick bilen blev full skrev appen kvittot,
skickade SMS och betraktade allt som över — medan bilen fortfarande stod
inkopplad. Gästsidan hoppade tillbaka till "Redo att ladda", som om stolpen var
fri, fast den inte var det.

Nu står det **"Bilen är klar"** med hur mycket som laddats och vad det kostar.
Den som laddat ser att det är färdigt och att kvittot kommer när kabeln dras ur.
Den som kommer gående ser att stolpen är upptagen men blir ledig så fort bilen
flyttas. Ingen behöver gissa.

**Och vaknar bilen igen räknas strömmen.** En bil som pausat kan börja dra ström
på nytt — för batterivård, eller förvärmning inför morgonen. Sessionen lever, så
den strömmen hamnar på rätt räkning i stället för att bli gratis. Skärmen går
tillbaka till "Laddar" av sig själv.

**Kvitto-SMS:et kommer när kabeln dras ur**, inte när bilen blir full. Det var
därför du fick din räkning mitt i natten medan bilen stod kvar till morgonen.

**Klar upptäcks på nittio sekunder i stället för tjugo minuter.** Den gamla
regeln väntade ut tjugo minuter utan effekt, oavsett vad boxen sa. Nu läses
driftläget: Easee rapporterar läge 4 när bilen slutat ta emot ström, och det
räcker med att det står sig i nittio sekunder. Att vara snabb är ofarligt nu —
en förhastad slutsats avslutar ingenting längre, den rättar bara sig själv om
bilen fortsätter.

**Med en spärr som är hela poängen.** Läge 4 heter "Completed" hos Easee men
betyder *bilen har pausat eller slutat ladda* — inte nödvändigtvis full. Och
läge 2 rymmer både en färdig bil och en bil som står i kö bakom
lastbalanseringen. Därför: stryper Equalizern är laddningen inte klar, oavsett
hur länge effekten legat på noll. Att kalla det färdigt vore att skriva kvitto
mitt i kön. De vaga lägena får fortfarande vänta ut sina tjugo minuter.

*Simulatorn hade samma förväxling inbyggd — den lät strypning se ut som läge 4.
Den är rättad, annars hade testet inte varit värt något.*

**Startlänken i SMS:et fungerar för alltid.** Den var en engångsnyckel med tio
minuters livslängd, så ett tryck dagen efter gav "Länken fungerar inte" — fast
det fanns en obetald räkning bakom den. Nu leder länken till just den
laddningens kvitto, hur lång tid som än gått.

**Kvittosidan visar dina tidigare laddningar.** Datum, mängd, belopp och om de
är betalda, med länk till varje kvitto. Praktiskt om någon laddat flera gånger
och vill se vad som är kvar att betala.

*Värt att veta: den som får en kvittolänk vidarebefordrad ser också personens
övriga laddningar hos dig. Det är avsiktligt men inte gratis.*

**46elks id och status står i loggen.** Ett SMS som "skickats" är bara ett SMS
46elks tagit emot — leveransen är en annan sak. Utan id:t går ett uteblivet SMS
inte att slå upp i deras panel. Loggraden säger nu *"Lämnat till 46elks"*, vilket
är vad den alltid har betytt.

## 0.5.2

**Gästsidan kraschade så fort kabeln satt i.** Två variabler i sidans skript
saknade deklaration. En tilldelning skapade dem i efterhand, men sidan *läser*
den ena vid varje avläsning så snart kabeln är ansluten — och en läsning före
första tilldelningen avbryter hela ritningen. Sidan har alltså aldrig kunnat
visa "Redo att ladda" sedan fas 5 lades in.

Felet syntes inte som ett fel. Det hamnade i nätverkets felhantering, och därför
stod det **"Ingen kontakt med laddstolpen"** — medan adminfliken samtidigt visade
kabeln som ansluten och allt annat såg friskt ut. Det var det du såg.

**Kvittot hämtades i fel format.** Kvittoadressen svarar med JSON bara om
webbläsaren ber om det, och gästsidan bad inte. Den fick en HTML-sida, försökte
läsa den som JSON och misslyckades — varje gång, för varje telefon som hade en
laddning sparad. Också det visades som "Ingen kontakt med laddstolpen". Kvittot
dyker nu upp av sig självt när du drar ur kabeln, vilket det inte har gjort.

**Och felhanteringen ljuger inte längre.** Tre olika fel hölls ihop i en enda
hantering, så vilket som helst av dem kunde rapporteras som vilket som helst av
de andra:

| Vad som gick fel | Vad sidan säger nu |
|---|---|
| Telefonen når inte appen | *Telefonen når inte appen* |
| Appen når inte laddboxen | *Ingen kontakt med laddstolpen* |
| Fel i appens egen kod | *Något gick fel i appen* |

Det tredje är nytt. En felhanterare som skyller på mobiltäckningen när felet
sitter i koden får dig att leta på fel ställe — precis vad som hände här.

**Fel i gästens webbläsare hamnar nu i din logg.** Du kommer aldrig att öppna
webbläsarens konsol på en grannes telefon. Utan det här är ett fel i sidan
osynligt för dig: gästen ser något konstigt, du ser en logg där allt ser bra ut.
Högst fem rapporter per timme och avsändare, och ingenting sparas på disk.

**Kontrollen före varje släpp kör nu sidan, inte bara läser den.** En riktig
webbläsare går igenom nitton vyer och hela gästflödet — kabel i, nummer, kod,
start, urdragning, kvitto — och underkänner bygget vid minsta fel i konsolen.
De två felen ovan är båda giltig JavaScript och passerade den gamla kontrollen
utan ett ljud.

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
