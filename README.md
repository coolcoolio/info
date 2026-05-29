# Hermes Signal

Statischer Nachrichten-Hub fuer deine Interessengebiete mit automatischer Archivierung und vorbereitetem Feed-Ingest.

## Lokal

```bash
npm run build:offline
npm start
```

Die Offline-Variante nutzt lokale Fixture-Feeds, damit der Build auch ohne externe Netzverbindung testbar bleibt.

## Verhalten

- Neue Artikel werden nach Relevanz fuer deine Interessen gewichtet.
- Nach `archiveAfterDays` verschwinden Artikel von der Startseite und landen im Archiv.
- Die Build-Historie wird in `data/state/articles.json` fortgeschrieben, damit archivierte Meldungen nicht verschwinden, nur weil ein Feed sie spaeter nicht mehr ausliefert.
- Nach `dropAfterDays` werden alte Eintraege aus dem lokalen Speicher entfernt.

## Live-Betrieb

- Gratis-Hosting: Cloudflare Pages oder GitHub Pages
- Aktualisierung: geplanter Build alle 2-6 Stunden
- Quellen: `config/sources.json`
- Interessen-Ranking und Archivregeln: `config/site.json`
- Persistente Historie: `data/state/articles.json`

## Deployment-Idee

1. Dieses Projekt in ein Git-Repo legen.
2. Bei GitHub Pages oder Cloudflare Pages deployen.
3. Den Workflow `.github/workflows/update-news.yml` aktivieren. Er baut alle 4 Stunden neu, aktualisiert `dist/` und schreibt die persistente Archivdatei zurueck ins Repo.

## Hinweise

- Der Ingest ist absichtlich dependency-free, damit er portabel bleibt.
- Einige Feeds koennen zeitweise ausfallen. Die Seite bleibt dann trotzdem buildbar und zeigt den Feed-Status an.
