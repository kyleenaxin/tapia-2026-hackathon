import { analyzeReviews, hasProfanity, isSubstantive } from './reviews.js';

const clean = (t) => String(t ?? '').replace(/^This review may contain spoilers\.?\s*/i, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);
const pct = (v10) => `${Math.round(v10 * 10)}%`;

// Builds a review summary from evidence that is actually present: dataset reviews, critic and audience scores.
export function reviewSummary(movie) {
  const reviews = (movie.reviews ?? []).map((r) => ({ author: r.user, content: clean(r.text), likes: r.likes }));
  const themes = analyzeReviews(reviews, { minMentions: 1 });
  const bySource = Object.fromEntries((movie.rating?.sources ?? []).map((s) => [s.source, s]));
  const lb = bySource.letterboxd;
  const rt = bySource.rottentomatoes;
  const rta = bySource['rt-audience'];
  const points = [];

  if (rt) {
    const d = rt.detail;
    points.push(d?.liked != null && d?.count
      ? `Critics: ${d.liked} of ${d.count} Rotten Tomatoes reviews were positive (${pct(rt.value)})${d.certified ? ', Certified Fresh' : ''}.`
      : `Critics: ${pct(rt.value)} positive on Rotten Tomatoes.`);
  }
  if (rta) points.push(`Rotten Tomatoes audience score: ${pct(rta.value)}.`);
  if (lb) points.push(`Letterboxd members rate it ${lb.value.toFixed(1)}/10${lb.votes ? ` across ${lb.votes.toLocaleString('en-US')} ratings` : ''}.`);

  if (rt && (lb || rta)) {
    const audience = rta ?? lb;
    const gap = rt.value - audience.value;
    if (Math.abs(gap) < 1) points.push('Critics and audiences broadly agree.');
    else if (gap > 0) points.push('Critics like it more than audiences do, so it may be an acquired taste or slower than the buzz suggests.');
    else points.push('Audiences like it more than critics do, which often means crowd-pleasing over critically polished.');
  }

  if (themes.available) {
    if (themes.strengths.length) points.push(`Reviewers praise the ${themes.strengths.join(' and ')}.`);
    if (themes.weaknesses.length) points.push(`Some reviewers criticize the ${themes.weaknesses.join(' and ')}.`);
    if (themes.contentConcerns.length) points.push(`Reviewers mention: ${themes.contentConcerns.map((c) => c.concern).join(', ')}.`);
  }

  // The most-liked reviews are often jokes, so only quote one that is on topic, clean and long enough to mean something.
  const quotable = reviews.filter((r) => r.content.length >= 80 && r.content.length <= 600 && !hasProfanity(r.content) && isSubstantive(r.content)).sort((a, b) => b.likes - a.likes)[0];
  const basis = reviews.length
    ? `Review text is the ${reviews.length} most-liked Letterboxd review${reviews.length > 1 ? 's' : ''} in the dataset. Those skew toward jokes and one-liners, so themes are tentative.`
    : 'No review text was available for this movie.';

  return {
    hasEvidence: points.length > 0 || reviews.length > 0,
    points,
    quote: quotable ? { user: quotable.author, text: clip(quotable.content, 240), likes: quotable.likes } : null,
    basis,
  };
}
