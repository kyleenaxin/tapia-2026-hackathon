# Up Next

Up Next is an agentic movie advisor. It helps one person pick a movie for themselves (**Solo**), or helps a group of friends or family pick something to watch together (**Group**), and it shows its reasoning for every pick.

Genre filters and popularity lists don't say why a movie is right for you tonight. Up Next asks a few questions, checks what it knows about the film from several sources, and returns one main pick and two backups. Each pick comes with the evidence behind it, its drawbacks, and a way to say "no, not this one."

Built for the Tapia 2026 hackathon.

## How it works

1. **Welcome.** The curtains open and you get a ticket.
2. **Solo or Group.** Solo is a screening for one. Group is a screening room that friends join.
3. **Preferences.** Mood, genres you like, genres and topics you want to avoid, content you'd rather skip, and how adventurous you're feeling.
4. **Follow-up questions.** If something that changes the answer is missing or unclear, the agent asks for that detail instead of guessing. This includes ambiguous titles (which *Dune*?) and titles it can't find.
5. **Recommendations.** One primary pick and two backups, each with why it fits, its drawbacks, the ratings behind it, and how confident the agent is.
6. **Feedback.** You can reject a pick and say why. The rejection is recorded, the pick is removed, and similar films are down-ranked. The model does not quietly override a person's "no."

In Group mode each person's preferences and hard "no"s count. A film that one person can't watch is excluded for everyone, and the result says whether a pick is a consensus or a compromise. It is not an average of star ratings.

## Quick start

Requires Node 22 or newer. There are no runtime dependencies.

```
npm start          # http://localhost:3000  (set PORT to change it)
npm run dev        # same, restarting on file changes
npm test           # run the test suite
npm run demo       # command-line walkthrough
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
| Letterboxd film page | Polite page fetch | Nothing |
| Rotten Tomatoes film page (critics and audience) | Polite page fetch | Nothing |
| IMDb and Metacritic (also Rotten Tomatoes) | OMDb API | `OMDB_API_KEY` (optional) |

Ratings from different sources are kept side by side, weighted by how much evidence stands behind each one, and shrunk toward the global mean when that evidence is thin. When sources disagree the result says so instead of averaging the disagreement away.

Content warnings (gore, scares, sexual content, disturbing themes) are a heuristic over the synopsis, Letterboxd theme labels and review text. A film is only filtered when at least two separate pieces of text mention it. A single mention becomes a "worth a quick check" note. The heuristic can miss things, and the app says so.

### Web scraping

The page fetches are deliberately gentle:

- They identify themselves with a clear `User-Agent` (`UpNextBot/0.1`) and check each site's `robots.txt` before any page request. A disallowed path is never fetched.
- They are limited to one request at a time per site, at least about 1.1 seconds apart.
- They do not follow redirects to other sites and cap the size of each page.
- Only the small parsed result (a score and a count) is cached, in `data/cache/`. Results last 7 days and misses last 1 day. Raw pages are never stored.
- Set `ENABLE_WEB_SCRAPING=0` to turn all page fetching off.

**Check the terms before deploying this publicly.** Scraping is subject to each site's terms of service, and a `robots.txt` that permits a path does not make automated access acceptable under those terms. Letterboxd and Rotten Tomatoes may not permit it, and this project has not obtained permission from either. It is set up for a hackathon demo, at low volume and with a visible identity. Before running it publicly or at any scale, review each site's terms, use their official APIs or partner programs where they exist, and turn scraping off if in doubt. The dataset has its own license, which you should also check before redistributing anything derived from it.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | Server port, default `3000` |
| `OMDB_API_KEY` | Adds IMDb and Metacritic ratings through OMDb |
| `ENABLE_WEB_SCRAPING` | Set to `0` to disable Letterboxd and Rotten Tomatoes page fetching |

Put these in your shell environment or a `.env` file. `.env` is git-ignored, and API keys should never be committed.

## Privacy

Watch history and preferences are personal. Group mode only uses information from people who chose to take part, and Up Next does not infer sensitive traits from what someone watches.

## Project layout

```
public/            browser assets
scripts/           build-data command
src/agent/         ranking, group logic, constraints, ratings, review analysis, sources
src/data/          catalog loading, index building
src/demo/          seeded demo people and the judge walkthrough
src/server.js      HTTP server
test/              node:test suites (npm test)
data/sample/       committed 1,500-film sample
```

## Testing

`npm test` uses Node's built-in test runner. Tests run against the committed sample or small synthetic catalogs, so they don't need the full index or any API key. Tests should never call the live sites. Inject a fake `fetch` instead.
