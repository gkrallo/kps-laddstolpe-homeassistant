# Ändringslogg

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
