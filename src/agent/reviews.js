// Extracts recurring strengths, weaknesses and content concerns from real review text.
// Audience reviews and critic scores are kept separate: they answer different questions.

const THEMES = {
  pacing: ['pacing', 'paced', 'slow burn', 'slow-burn', 'dragged', 'drags', 'slow', 'tight', 'fast-paced', 'plodding'],
  performances: ['performance', 'performances', 'acting', 'actor', 'actress', 'cast'],
  visuals: ['visual', 'visuals', 'cinematography', 'beautiful', 'stunning', 'effects', 'shot'],
  story: ['story', 'plot', 'script', 'writing', 'screenplay', 'twist', 'ending', 'predictable'],
  music: ['soundtrack', 'score', 'music', 'sound design'],
  humor: ['funny', 'humor', 'humour', 'jokes', 'laugh', 'hilarious'],
  emotion: ['emotional', 'moving', 'heartfelt', 'touching', 'tearjerker', 'cry', 'cried'],
  length: ['overlong', 'too long', 'runtime', 'long movie', 'lengthy'],
};

const POSITIVE = ['great', 'excellent', 'brilliant', 'beautiful', 'stunning', 'amazing', 'love', 'loved', 'perfect', 'masterpiece', 'tight', 'fast-paced', 'funny', 'hilarious', 'moving', 'heartfelt', 'touching', 'superb', 'gripping', 'fantastic', 'outstanding'];
const NEGATIVE = ['boring', 'slow', 'dragged', 'drags', 'predictable', 'weak', 'poor', 'disappointing', 'disappointed', 'flat', 'confusing', 'overlong', 'too long', 'plodding', 'mess', 'bad', 'awful', 'lengthy', 'forgettable', 'cliche', 'cliché'];

const CONCERNS = {
  'graphic violence': ['gore', 'gory', 'graphic violence', 'brutal', 'bloody'],
  'disturbing content': ['disturbing', 'unsettling', 'traumatic'],
  'jump scares': ['jump scare', 'jump scares'],
  'sexual content': ['sex scene', 'nudity', 'sexual content'],
  'strong language': ['profanity', 'strong language', 'swearing'],
  'drug use': ['drug use', 'drugs'],
};

const has = (text, words) => words.filter((w) => text.includes(w));

export function analyzeReviews(reviews, { minMentions = 2 } = {}) {
  const usable = reviews.filter((r) => typeof r.content === 'string' && r.content.trim().length > 20);
  if (!usable.length) {
    return { available: false, reviewCount: 0, note: 'No review text was available for this movie, so no review themes are reported.' };
  }
  const themes = Object.fromEntries(Object.keys(THEMES).map((t) => [t, { mentions: 0, positive: 0, negative: 0, quote: null }]));
  const concerns = {};
  for (const r of usable) {
    const sentences = r.content.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const text = s.toLowerCase();
      const pos = has(text, POSITIVE).length;
      const neg = has(text, NEGATIVE).length;
      for (const [theme, words] of Object.entries(THEMES)) {
        if (!has(text, words).length) continue;
        const t = themes[theme];
        t.mentions++;
        if (pos > neg) t.positive++;
        else if (neg > pos) t.negative++;
        if (!t.quote && (pos !== neg)) t.quote = { author: r.author ?? 'anonymous', text: s.length > 180 ? `${s.slice(0, 177)}...` : s };
      }
      for (const [concern, words] of Object.entries(CONCERNS)) {
        if (has(text, words).length) concerns[concern] = (concerns[concern] ?? 0) + 1;
      }
    }
  }
  const summarized = Object.entries(themes)
    .filter(([, t]) => t.mentions >= minMentions)
    .map(([theme, t]) => ({
      theme,
      ...t,
      tone: t.positive > t.negative * 1.5 ? 'praised' : t.negative > t.positive * 1.5 ? 'criticized' : 'mixed',
    }))
    .sort((a, b) => b.mentions - a.mentions);
  const rated = usable.map((r) => r.rating).filter((x) => typeof x === 'number');
  return {
    available: true,
    reviewCount: usable.length,
    audienceAverage: rated.length ? Number((rated.reduce((a, b) => a + b, 0) / rated.length).toFixed(1)) : null,
    strengths: summarized.filter((t) => t.tone === 'praised').map((t) => t.theme),
    weaknesses: summarized.filter((t) => t.tone === 'criticized').map((t) => t.theme),
    themes: summarized,
    contentConcerns: Object.entries(concerns).sort((a, b) => b[1] - a[1]).map(([concern, mentions]) => ({ concern, mentions })),
    note: usable.length < 5 ? `Based on only ${usable.length} review(s); treat themes as tentative.` : '',
  };
}

const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|dick\w*|cock\w*|pussy|slut\w*|whore\w*|nigg\w*|fag\w*|retard\w*|porn\w*)\b/i;
export const hasProfanity = (text) => PROFANITY.test(text);

// A review is worth quoting when it says something about the film (a quality or a reaction), not just a joke.
const LAUGH_MARKERS = /\b(lol|lmao|rofl|haha+|tbh|imo)\b/i;
const JOKE_WORDS = new Set(['funny', 'hilarious']);

export function isSubstantive(text) {
  const t = String(text).toLowerCase();
  if (LAUGH_MARKERS.test(t)) return false;
  // Humor words show up in jokes about a film far more than in assessments of it, so they do not count on their own.
  const themed = Object.entries(THEMES).some(([theme, words]) => theme !== 'humor' && has(t, words).length);
  const evaluative = has(t, POSITIVE).some((w) => !JOKE_WORDS.has(w)) || has(t, NEGATIVE).length > 0;
  return themed || evaluative;
}
