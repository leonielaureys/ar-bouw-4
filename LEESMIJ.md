# AR-Bouw v1.0 — structuur, wapening en technieken in AR (Meta Quest 3)

Webapp: er is niets te installeren op de bril. Ze draait in de Quest-browser via WebXR (passthrough-AR).

## Online zetten (GitHub Pages, bestaande repo `revit-vr`)
1. GitHub › repo `revit-vr` › **Add file › Upload files**.
2. Sleep de map **`ar`** volledig in het venster (met `js/` en `projecten/`) › Commit.
3. Na ±1 min staat de app op `https://<gebruiker>.github.io/revit-vr/ar/`.
4. Open dat adres op de Quest. Je Revit-modellen in `modellen/` (root van de repo) verschijnen automatisch in de lijst.

## Werkwijze in een ruimte
1. Kies het project (of **QR scannen**) › **Start AR**.
2. Het menu hangt boven je linkercontroller. Wijs met de rechtercontroller en druk de trekker.
3. Eerste keer: **Kalibreren › 2 hoeken** (wijs vloerhoek 1 en 2 aan volgens het plannetje), of hou de **grijpknop** ingedrukt en versleep het model. Fijn bijregelen gaat met de joysticks.
4. **Inmeten › Uit ruimte-scan** neemt de echte muren, het plafond, de deur en de ramen over uit de ruimte-instelling van de Quest.
5. **Plaatsen**: duid echte stopcontacten, schakelaar, lavabo, schacht enz. aan. Die gelden als *bevestigd*, en de app trekt de leidingen er volgens de regels naartoe.
6. **QR-bladen printen** (vanop de online versie!) › blad ophangen › **Kalibreren › QR registreren** (kruisje L, dan R).
   Volgende keer: QR scannen › Start AR › L en R aantikken. Of: **Bewaar positie** (persistent anchor).

## Modi
Verkennen · Kalibreren · Inmeten · Plaatsen · Snede · Meten (boorcheck + meetlint) · Notities · Bouwfasen · Presentatie

## Gestreept = aanname
Alles wat gegenereerd is, wordt gestreept getoond met de vermelding AANNAME. Gebruik dit nooit om te boren.
Grondslag: EN 1990/1991/1992 (+ANB) voor de vloeren en de betonwanden, EC6/EC5 voor metselwerk en hout,
het AREI voor elektriciteit, EN 12056-2 voor de afvoer, NBN D 50-001 voor ventilatie en het KB Basisnormen voor brand.

## Projecten toevoegen
- `projecten/*.json` + vermelden in `projecten/index.json` (vaste modellen).
- **Exporteer project** in de app levert zo'n JSON op, inclusief inmeting, QR-bladen en notities.
