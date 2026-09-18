# Up Next

Up Next is an agentic movie advisor. It helps one person pick a movie for themselves (**Solo**), or helps a group of friends or family pick something to watch together (**Group**), and it shows its reasoning for every pick.

Genre filters and popularity lists don't say why a movie is right for you tonight. Up Next asks a few questions, checks what it knows about the film from several sources, and returns one main pick and two backups. Each pick comes with the evidence behind it, its drawbacks, and a way to say "no, not this one."

Built for the Tapia 2026 hackathon.

## How it works

It is a real multi-page website (server-rendered, with a session cookie), styled like a vintage movie theater.

1. **Welcome.** Red curtains are drawn. Tap the ticket and they open.
2. **Solo or Group.** Solo is a screening for one. Group is a screening room others join.
3. **Preferences.** Favorite genres, current mood, movies you loved, movies you disliked, movies you have already watched, maximum runtime, hard no's (genres, content types, or words), and an optional Letterboxd export import (ratings.csv, watched.csv or watchlist.csv).
4. **Follow-up questions.** The agent asks one or two questions only when it cannot safely guess: an ambiguous title (which *Dune*?), a near-miss title, a loved film in a genre you listed as a hard no, no mood chosen, or almost no taste signal.
5. **The agent works, live.** The page shows every tool call as it happens: read profile, scan the dataset, shortlist, check Letterboxd and Rotten Tomatoes for the finalists, drop anything over your runtime limit, re-rank on the new evidence, write up.
6. **Recommendations.** One main pick and two backups. Each shows why it was recommended, ratings from multiple sources (conflicts are flagged, not averaged away), a review summary, and potential drawbacks.
7. **Feedback.** Mark a pick **Watched**, **Want to watch**, **Thumbs up** or **Thumbs down** (with a reason). The agent re-runs and tells you what changed. A thumbs down is recorded with your reason, the pick is removed, and similar films are down-ranked. The model never quietly overrides a person's "no."

**Group mode** works through screening rooms. The host gets a 4-letter code and an invite link, people join with an explicit consent screen, and for in-person nights the host can add people on the same device. Each person's preferences and hard no's count. A film any member cannot watch is out for everyone, and each pick is labeled Consensus, Compromise or Balanced with per-person fit bars. It is not an average of star ratings. A group thumbs down (chosen per person) vetoes the film for the whole room and names who said no.

**Friends' activity.** When someone in your room marks a movie, the agent compares it with your history and shows what changed in your list (rank before and after, a watch/maybe/skip verdict, and similar films worth watching too).

**Judge walkthrough** (`/judge`). Runs the real agent live on seeded demo people (Alex, Sam, Maya; Jordan is deliberately not in the room) and shows: a recommendation with its reasoning, what changed when a friend added a movie, and a group recommendation a member vetoed. The disagreement is labeled as an illustrative example; a real one recorded through the app is stored the same way.

## Quick start

Requires Node 22 or newer. There are no runtime dependencies.

```
npm start          # http://localhost:3000  (set PORT to change it)
npm run dev        # same, restarting on file changes
npm test           # run the test suite
npm run demo       # run the solo agent once from the command line (uses live sources)
```

It works out of the box on the 1,500-film sample in `data/sample/`. To use the full catalog, build the index once:

```
npm run build-data
```

## Data

Movie data comes from the Hugging Face dataset [`pkchwy/letterboxd-all-movie-data`](https://huggingface.co/datasets/pkchwy/letterboxd-all-movie-data), which holds Letterboxd film metadata, ratings and popular reviews.

`npm run build-data` streams that dump (about 1.1 GB) once and writes a compact index to `data/letterboxd.index.jsonl`. Only the index is saved. It keeps films that have a rating, at least 5 reviews, and meaningful review engagement, which comes to roughly 30,000 films. The index is git-ignored. The committed sample is the 1,500 most-engaged of those.

```
npm run build-data                                 # download and index the full dump
npm run build-data -- --input path/to/dump.jsonl   # use a local copy
npm run build-data -- --sample                     # also regenerate data/sample/
npm run build-data -- --min-reviews 8 --min-popularity 500
```

The app reports which file it loaded (index or sample). If the index is missing it falls back to the sample and says so.

**Limits of this data.** It is a snapshot. Letterboxd ratings here are on a /5 scale, converted to /10, and there is no real vote count, so review engagement stands in as the weight. The dataset has no runtime, no streaming availability, and no critic scores.

## What the agent looks at

For each candidate the agent starts with the **local index** and can add live evidence from other sources. Every source is reported as what it actually did (`ok`, `blocked`, `not-found`, `disabled`, `error`, and so on). A source that was not queried is never presented as if it had been.

| Source | How | Needs |
| --- | --- | --- |
| Local index (Letterboxd dataset) | Read from disk | Nothing |
| Letterboxd film page | Polite page fetch: live rating, number of ratings, runtime, IMDb id | Nothing |
| Wikidata | Open API: IMDb id to Rotten Tomatoes id, so the right RT page is found | Nothing |
| Rotten Tomatoes film page | Polite page fetch: critics and audience scores | Nothing |
| IMDb and Metacritic (also Rotten Tomatoes) | OMDb API | `OMDB_API_KEY` (optional) |

Rotten Tomatoes slugs are not always the title (*The Prestige* is `m/prestige`), so the agent asks Wikidata for the id first. Guessed slugs are only accepted when the page title and release year both match, so a remake is never scored as the original.

Runtime is not in the dataset, so the agent reads it from the Letterboxd page and applies your limit to live data. Featurettes and shorts are filtered out.

Ratings from different sources are kept side by side, weighted by how much evidence stands behind each one, and shrunk toward neutral when that evidence is thin. When sources disagree the result says so instead of averaging the disagreement away.

**Review summaries** use what is actually available: Rotten Tomatoes critic counts, audience scores, and the dataset's most-liked Letterboxd reviews. Those reviews skew toward jokes, so the app quotes one only if it is clean and on topic, otherwise it shows no quote, and it says what the summary is based on.

Content warnings (gore, scares, sexual content, disturbing themes) are a heuristic over the synopsis, Letterboxd theme labels and review text. A film is only filtered when at least two separate pieces of text mention it. A single mention becomes a "worth a quick check" note. The heuristic can miss things, and the app says so.

### Web scraping

The page fetches are deliberately gentle:

- They identify themselves with a clear `User-Agent` (`UpNextBot/0.1`) and check each site's `robots.txt` before any page request. A disallowed path is never fetched.
- They are limited to one request at a time per site, at least about 1.1 seconds apart.
- They do not follow redirects to other sites and cap the size of each page.
- Only the small parsed result (a score and a count) is cached, in `data/cache/`. Results last 7 days and misses last 1 day. Raw pages are never stored.
- Documented APIs (OMDb, Wikidata) are called as APIs, still rate limited, with the same identifying `User-Agent`.
- If a site blocks or refuses, the agent reports that and continues with the other sources. It does not try to get around blocking.
- Set `ENABLE_WEB_SCRAPING=0` to turn all page fetching off.

**Check the terms before deploying this publicly.** Scraping is subject to each site's terms of service, and a `robots.txt` that permits a path does not make automated access acceptable under those terms. Letterboxd and Rotten Tomatoes may not permit it, and this project has not obtained permission from either. It is set up for a hackathon demo, at low volume and with a visible identity. Before running it publicly or at any scale, review each site's terms, use their official APIs or partner programs where they exist, and turn scraping off if in doubt. The dataset has its own license, which you should also check before redistributing anything derived from it.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | Server port, default `3000` |
| `OMDB_API_KEY` | Adds IMDb and Metacritic ratings through OMDb |
| `ENABLE_WEB_SCRAPING` | Set to `0` to disable Letterboxd and Rotten Tomatoes page fetching |

Copy `.env.example` to `.env` to set them.

Put these in your shell environment or a `.env` file. `.env` is git-ignored, and API keys should never be committed.

## Privacy

Your answers live under a private, HttpOnly cookie in your browser. Watch history and preferences are personal: in Group mode only members of a room see each other's taste, each person opts in by joining, and leaving revokes access. Results pages are private to their owner (or the room). Up Next does not infer sensitive traits from what someone watches. The site sends a strict Content-Security-Policy, escapes all user text, and refuses cross-site form posts.

## Project layout

```
public/            site.css, site.js (curtains, title pickers, live log), self-hosted fonts
scripts/           build-data (index the dataset), get-fonts, try-agent (dev helper)
src/web/           server-rendered pages: layout, views, rooms, results, judge, forms, security
src/agent/         agent.js (the tool loop), intake (questions, Letterboxd import), jobs (live runs),
                   rank, group, watcher, constraints, ratings, reviews, sources/ (polite fetching)
src/data/          catalog loading, index building
src/demo/          seeded demo people and the judge scenario
src/store.js       people, watch lists, feedback, screening rooms, events
src/server.js      HTTP entry point
test/              node:test suites (npm test)
data/sample/       committed 1,500-film sample
```

## Testing

`npm test` uses Node's built-in test runner. Tests run against the committed sample or small synthetic catalogs, so they don't need the full index or any API key. Tests never call the live sites: page parsers are tested against trimmed real page excerpts in `test/fixtures/sources/`, and the agent and website are tested with `test/fakeSources.js`. The web tests drive the real server over HTTP (cookies, forms, uploads, rooms, feedback, CSRF, XSS).
