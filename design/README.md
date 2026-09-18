# Front-end prototype

A self-contained, clickable prototype of the Up Next front end. It shares no code with `src/` or `public/`, and the server does not serve it. Open `design/index.html` directly in a browser. No build step or server is needed.

## What is real and what is mock

- **Real:** the 26 films (titles, directors, cast, synopses, Letterboxd ratings, the two most-liked reviews) are rows from `data/sample/letterboxd-sample.jsonl`, written to `mock-films.js`.
- **Mock:** the ranking in `app.js` is a small stand-in so the UI reacts to choices. It is not the real agent. The friends in Group mode (Alex, Sam, Maya, Jordan) are seeded demo people.
- **Not shown as if it happened:** Rotten Tomatoes, IMDb and Metacritic appear as "not run in the prototype", never with invented scores. The states page (`#/states`) uses a clearly synthetic "Example Film" to show conflicts, blocked sources and ambiguous titles.

## Jump to a screen

Add a hash to `index.html`:

| Hash | Screen |
| --- | --- |
| `#/welcome` | Closed curtains |
| `#/welcome-open` | Curtains open, ticket |
| `#/mode` | Solo or Group |
| `#/prefs`, `#/prefs-empty` | Preferences (example filled in, or blank) |
| `#/ask` | A follow-up question |
| `#/results` | One pick and two backups |
| `#/group-room` | Room with invite code |
| `#/group-results` | Group pick with per-person fit |
| `#/states` | Component states |

## Handing it to the real app

- `styles.css` is plain CSS with tokens on `:root` and class-based components. It can be linked from server-rendered pages as is.
- Each view in `app.js` (`vWelcome`, `vPrefs`, `pickCard`, `backupCard`, `vRoom`, ...) is a function that returns an HTML string from plain data, so it can be copied into a template.
- `MOODS`, `FLAGS` and the genre list mirror `src/agent/constraints.js` and `CANON_GENRES`. If those change, update them here.
- The data has no posters, runtime or streaming availability, so the prototype uses a typographic placeholder poster and does not offer runtime filters.

## Accessibility

Headings receive focus on each screen change, chips and moods are toggle buttons with `aria-pressed`, the feedback dialog traps focus visually and closes on Escape, meters have `aria-valuenow`, and animation is disabled under `prefers-reduced-motion`. Checked at 1200px and 390px with no horizontal overflow.
