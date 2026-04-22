# mPortal Name Highlighter (Tampermonkey)

Tampermonkey-Userscript fuer mPortal, um Personen im Anwesenheits-Display schneller zu finden, farbig zu markieren und den Status-Indikator (anwesend/abwesend) besser sichtbar zu machen.

## Features

- Automatische Erkennung von Namen aus den Anwesenheits-Kacheln
- Auswahl von Namen ueber ein Dropdown mit Checkboxen
- Suchfeld im Dropdown zum schnellen Filtern
- Individuelle Farbe pro Person + globale Standardfarbe
- Favoriten pro ausgewaehlter Person per Stern (☆/★) im Panel
- Separate Favoriten-Leiste oberhalb der normalen Kacheln (nur sichtbar, wenn Favoriten gesetzt sind)
- Favoriten-Kacheln werden zusaetzlich angezeigt, Original-Kacheln bleiben unveraendert in der normalen Liste
- Persistente Speicherung (Auswahl, Farben, Optionen)
- Modus fuer Namensquelle:
  - Nur sichtbare Kacheln
  - Alle geladenen Kacheln
- Option fuer Status-Balken-Hervorhebung:
  - Bei allen Personen
  - Nur bei ausgewaehlten Personen
  - Gar nicht hervorheben
- Live-Update bei Farbaenderungen

## Voraussetzungen

- Browser mit [Tampermonkey](https://www.tampermonkey.net/)
- Zugriff auf mPortal Anwesenheitsseite

## Installation

1. Tampermonkey installieren.
2. In Tampermonkey ein neues Script anlegen.
3. Inhalt von `mportal-name-highlighter.user.js` einfuegen.
4. Speichern.
5. mPortal Anwesenheitsseite neu laden.

## Verwendung

1. Im Header auf **Highlight Namen** klicken.
2. Im Panel:
   - **Namen auswaehlen** oeffnen
   - Personen per Checkbox an-/abwaehlen
   - Optional Personen ueber den Stern als Favorit markieren
   - Optional pro Person Farbe setzen
   - Optional Standardfarbe setzen
3. Optional Namensquelle und Status-Balken-Modus einstellen.
4. Favoriten erscheinen in einer separaten Leiste oben und werden nebeneinander angezeigt.

## Gespeicherte Daten

Das Script speichert lokale Einstellungen (via GM Storage, Fallback `localStorage`):

- Gefundene Namen
- Ausgewaehlte Namen
- Favoriten-Namen
- Farbzuteilungen pro Name
- Standardfarbe
- Modus fuer Namensquelle
- Modus fuer Status-Balken-Hervorhebung

## Bedienelemente

- **Jetzt aktualisieren**: Liste mit Namen manuell neu synchronisieren
- **Auswahl leeren**: Loescht ausgewaehlte Namen und Favoriten (mit Sicherheitsabfrage)
- **Schliessen**: Panel schliessen

## Troubleshooting

- **Keine Namen sichtbar im Dropdown**
  - Pruefen, ob die Anwesenheits-Kacheln geladen sind
  - `Jetzt aktualisieren` klicken
  - Namensquelle auf **Alle geladenen Kacheln** stellen

- **Farben aktualisieren sich nicht**
  - Seite neu laden
  - Tampermonkey Script aktiv? (Dashboard pruefen)

- **Button erscheint nicht im Header**
  - Seite vollstaendig laden lassen
  - Eventuell Browser-Cache leeren und neu laden
