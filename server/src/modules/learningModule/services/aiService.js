const axios = require("axios");

/**
 * Turns a lecture transcript into study material.
 *
 * Two providers, picked automatically:
 *
 *   claude    — used when LM_AI_API_KEY (or ANTHROPIC_API_KEY) is set. Produces
 *               genuinely written notes, tutorials and questions.
 *   heuristic — a dependency-free extractive fallback. It keeps every screen in
 *               the AI Studio functional on a machine with no API key (dev
 *               boxes, the campus server before the key is provisioned) instead
 *               of erroring out, and clearly labels its output as such.
 *
 * Nothing else in the module cares which one ran; the provider name is stored
 * on the generated artefact so the UI can show it.
 */

const API_URL = process.env.LM_AI_API_URL || "https://api.anthropic.com/v1/messages";
const API_KEY = process.env.LM_AI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.LM_AI_MODEL || "claude-sonnet-4-5";
const MAX_TRANSCRIPT_CHARS = Number(process.env.LM_AI_MAX_CHARS || 120000);
const TIMEOUT_MS = Number(process.env.LM_AI_TIMEOUT_MS || 120000);

const isConfigured = () => Boolean(API_KEY);

const clip = (text) =>
  String(text || "").length > MAX_TRANSCRIPT_CHARS
    ? `${String(text).slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[transcript truncated]`
    : String(text || "");

async function callClaude(system, prompt, maxTokens = 4096) {
  const { data } = await axios.post(
    API_URL,
    {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    },
    {
      timeout: TIMEOUT_MS,
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    },
  );
  return (data?.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Models sometimes wrap JSON in prose or a ```json fence even when told not
// to; pull out the first balanced object/array rather than failing the job.
function extractJson(raw) {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (err2) {
      return null;
    }
  }
}

const contextLine = (ctx = {}) =>
  [
    ctx.className && `Course: ${ctx.className}`,
    ctx.subject && `Subject: ${ctx.subject}`,
    ctx.title && `Lecture: ${ctx.title}`,
  ]
    .filter(Boolean)
    .join(" | ") || "an undergraduate engineering lecture";

/* ────────────────────────── heuristic fallback ────────────────────────── */

const STOP_WORDS = new Set(
  ("the a an and or but if then so of to in on at for with by from as is are was were be been being " +
    "this that these those it its we you they he she i our your their there here what which who whom " +
    "will would can could should shall may might must do does did done have has had not no yes okay ok " +
    "right now just also very much more most some any all other such only own same than too s t don now " +
    "about into over under again further once because while during before after above below up down out " +
    "off between both each few nor own too let us going got get like know see say said one two").split(
    " ",
  ),
);

const sentencesOf = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

function keywordScores(text) {
  const counts = new Map();
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  return counts;
}

function topKeywords(text, limit = 12) {
  return [...keywordScores(text).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

// Classic centroid-free extractive ranking: score each sentence by the summed
// frequency of the keywords it contains, normalised by length so long rambling
// sentences do not dominate.
function rankSentences(text, limit) {
  const counts = keywordScores(text);
  return sentencesOf(text)
    .map((sentence, index) => {
      const words = sentence.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
      const score =
        words.reduce((sum, w) => sum + (counts.get(w) || 0), 0) / Math.sqrt(words.length || 1);
      return { sentence, index, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);
}

const HEURISTIC_BANNER =
  "> _Generated without an AI provider configured — this is an extractive draft built from the transcript. " +
  "Set `LM_AI_API_KEY` on the server for full AI-written material, and review before publishing._\n";

function heuristicNotes(transcript, ctx) {
  const keywords = topKeywords(transcript, 10);
  const highlights = rankSentences(transcript, 12);
  const chunkSize = Math.ceil(highlights.length / 3) || 1;
  const sections = [
    { heading: "Opening concepts", items: highlights.slice(0, chunkSize) },
    { heading: "Main discussion", items: highlights.slice(chunkSize, chunkSize * 2) },
    { heading: "Wrap-up", items: highlights.slice(chunkSize * 2) },
  ].filter((section) => section.items.length);

  const markdown = [
    `# ${ctx.title || "Lecture notes"}`,
    "",
    HEURISTIC_BANNER,
    "",
    "## Key terms",
    keywords.map((k) => `- **${k}**`).join("\n") || "- _none detected_",
    "",
    ...sections.flatMap((section) => [
      `## ${section.heading}`,
      section.items.map((s) => `- ${s}`).join("\n"),
      "",
    ]),
  ].join("\n");

  return { markdown, outline: sections.map((s) => s.heading), provider: "heuristic" };
}

function heuristicTutorial(transcript, ctx) {
  const keywords = topKeywords(transcript, 8);
  const highlights = rankSentences(transcript, 8);
  const keyTerms = keywords.map((term) => {
    const definition =
      sentencesOf(transcript).find((s) => s.toLowerCase().includes(term)) ||
      "Mentioned in the lecture — expand with your own definition.";
    return { term, definition };
  });

  const markdown = [
    `# Tutorial — ${ctx.title || "Lecture"}`,
    "",
    HEURISTIC_BANNER,
    "",
    "## Walkthrough",
    highlights.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "",
    "## Practise",
    keywords.slice(0, 5).map((k) => `- Explain **${k}** in your own words and give one example.`).join("\n"),
  ].join("\n");

  return {
    markdown,
    summary: highlights.slice(0, 3).join(" "),
    keyTerms,
    flashcards: keyTerms.slice(0, 8).map((t) => ({ front: t.term, back: t.definition })),
    faq: highlights.slice(0, 4).map((s) => ({
      question: `What was said about "${s.split(" ").slice(0, 6).join(" ")}…"?`,
      answer: s,
    })),
    furtherReading: [],
    provider: "heuristic",
  };
}

function heuristicQuiz(transcript, ctx, count) {
  const keywords = topKeywords(transcript, count * 2);
  const sentences = rankSentences(transcript, count * 2);

  const questions = [];
  for (let i = 0; i < Math.min(count, sentences.length); i += 1) {
    const sentence = sentences[i];
    const answerWord =
      keywords.find((k) => sentence.toLowerCase().includes(k)) || keywords[i % keywords.length];
    if (!answerWord) break;

    const distractors = keywords.filter((k) => k !== answerWord).slice(0, 3);
    if (distractors.length < 3) break;

    const options = [answerWord, ...distractors];
    // Deterministic rotation instead of Math.random so regenerating the same
    // transcript twice produces the same draft.
    const shift = i % options.length;
    const rotated = [...options.slice(shift), ...options.slice(0, shift)];

    questions.push({
      question: `Which term completes this point from the lecture? "${sentence.replace(
        new RegExp(answerWord, "ig"),
        "______",
      )}"`,
      type: "mcq",
      options: rotated,
      correctAnswers: [String(rotated.indexOf(answerWord))],
      explanation: `The lecture stated: "${sentence}"`,
      marks: 1,
      difficulty: "easy",
      topic: ctx.subject || "",
      sourceExcerpt: sentence.slice(0, 240),
    });
  }
  return { questions, provider: "heuristic" };
}

/* ───────────────────────────── public API ─────────────────────────────── */

async function generateNotes(transcript, ctx = {}) {
  if (!isConfigured()) return heuristicNotes(transcript, ctx);

  const raw = await callClaude(
    "You are an experienced university teaching assistant who writes clear, exam-ready lecture notes. " +
      "Output GitHub-flavoured Markdown only — no preamble, no code fences around the whole document.",
    `Below is the transcript of ${contextLine(ctx)}. Write structured revision notes for the students.

Requirements:
- Start with an H1 title, then a 2-3 sentence overview.
- Use H2 sections that follow the lecture's actual progression.
- Bullet the key points; bold every technical term the first time it appears.
- Include a "Formulae & definitions" section if the lecture contains any.
- Include worked examples the lecturer gave, cleaned up.
- Finish with "Key takeaways" (5-7 bullets) and "Questions to test yourself" (5 items).
- Silently skip filler, attendance calls and off-topic chatter.

TRANSCRIPT:
"""
${clip(transcript)}
"""`,
    6000,
  );

  if (!raw) return heuristicNotes(transcript, ctx);
  const outline = raw
    .split("\n")
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim());
  return { markdown: raw, outline, provider: `claude:${MODEL}` };
}

async function generateTutorial(transcript, ctx = {}) {
  if (!isConfigured()) return heuristicTutorial(transcript, ctx);

  const raw = await callClaude(
    "You are a university teaching assistant building a self-study tutorial. " +
      "Respond with a single JSON object and nothing else.",
    `From the transcript of ${contextLine(ctx)}, build a self-study tutorial.

Return exactly this JSON shape:
{
  "summary": "3-4 sentence plain-language summary",
  "markdown": "A full tutorial in Markdown: learning objectives, a step-by-step walkthrough of the concepts, at least two worked examples, common mistakes, and a short practice set with solutions",
  "keyTerms": [{"term": "...", "definition": "..."}],
  "flashcards": [{"front": "...", "back": "..."}],
  "faq": [{"question": "...", "answer": "..."}],
  "furtherReading": ["topic or textbook chapter to read next"]
}

Aim for 8-12 key terms, 10 flashcards and 5 FAQ entries.

TRANSCRIPT:
"""
${clip(transcript)}
"""`,
    8000,
  );

  const parsed = extractJson(raw);
  if (!parsed) return heuristicTutorial(transcript, ctx);

  return {
    markdown: parsed.markdown || "",
    summary: parsed.summary || "",
    keyTerms: Array.isArray(parsed.keyTerms) ? parsed.keyTerms : [],
    flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards : [],
    faq: Array.isArray(parsed.faq) ? parsed.faq : [],
    furtherReading: Array.isArray(parsed.furtherReading) ? parsed.furtherReading : [],
    provider: `claude:${MODEL}`,
  };
}

async function generateQuiz(transcript, ctx = {}, options = {}) {
  const count = Math.min(Math.max(Number(options.count) || 10, 1), 30);
  const difficulty = options.difficulty || "mixed";
  if (!isConfigured()) return heuristicQuiz(transcript, ctx, count);

  const raw = await callClaude(
    "You are a university examiner writing objective questions. Respond with a single JSON array and nothing else.",
    `From the transcript of ${contextLine(ctx)}, write ${count} assessment questions (${difficulty} difficulty).

Return a JSON array where each element is:
{
  "question": "...",
  "type": "mcq" | "msq" | "truefalse" | "short",
  "options": ["...", "..."],           // 4 options for mcq/msq, ["True","False"] for truefalse, [] for short
  "correctAnswers": ["0"],              // indices as strings for mcq/msq/truefalse; the expected answer text for short
  "explanation": "why that is the answer",
  "marks": 1,
  "difficulty": "easy" | "medium" | "hard",
  "topic": "the sub-topic this tests",
  "sourceExcerpt": "the sentence from the transcript this is based on"
}

Rules:
- Roughly 70% mcq, then a mix of msq, truefalse and short.
- Test understanding, not recall of the lecturer's exact wording.
- Every distractor must be plausible.
- Only use content actually present in the transcript.

TRANSCRIPT:
"""
${clip(transcript)}
"""`,
    8000,
  );

  const parsed = extractJson(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list) || !list.length) return heuristicQuiz(transcript, ctx, count);

  const questions = list
    .filter((q) => q && q.question)
    .map((q) => ({
      question: String(q.question),
      type: ["mcq", "msq", "truefalse", "short"].includes(q.type) ? q.type : "mcq",
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      correctAnswers: Array.isArray(q.correctAnswers)
        ? q.correctAnswers.map(String)
        : [String(q.correctAnswers ?? "")],
      explanation: String(q.explanation || ""),
      marks: Number(q.marks) || 1,
      difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
      topic: String(q.topic || ""),
      sourceExcerpt: String(q.sourceExcerpt || "").slice(0, 400),
    }));

  return { questions, provider: `claude:${MODEL}` };
}

async function generateSummary(transcript, ctx = {}) {
  if (!isConfigured()) {
    return { text: rankSentences(transcript, 4).join(" "), provider: "heuristic" };
  }
  const raw = await callClaude(
    "You summarise university lectures in plain language.",
    `Summarise ${contextLine(ctx)} in 4-5 sentences a student who missed the class could read in 30 seconds.

TRANSCRIPT:
"""
${clip(transcript)}
"""`,
    1024,
  );
  return { text: raw || rankSentences(transcript, 4).join(" "), provider: `claude:${MODEL}` };
}

/** Answers a student's free-text question against the lecture transcript. */
async function answerFromTranscript(transcript, question, ctx = {}) {
  if (!isConfigured()) {
    const counts = keywordScores(question);
    const best = sentencesOf(transcript)
      .map((sentence) => ({
        sentence,
        score: sentence
          .toLowerCase()
          .split(/\s+/)
          .reduce((sum, w) => sum + (counts.get(w) ? 1 : 0), 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.sentence);

    return {
      text: best.length
        ? `From the lecture:\n\n${best.map((s) => `> ${s}`).join("\n\n")}`
        : "No AI provider is configured and nothing in the transcript matched that question.",
      provider: "heuristic",
    };
  }

  const raw = await callClaude(
    "You are a teaching assistant answering a student's question strictly from the supplied lecture transcript. " +
      "If the transcript does not contain the answer, say so plainly rather than guessing.",
    `Question: ${question}

Lecture context: ${contextLine(ctx)}

TRANSCRIPT:
"""
${clip(transcript)}
"""`,
    2048,
  );
  return { text: raw || "No answer could be generated.", provider: `claude:${MODEL}` };
}

module.exports = {
  isConfigured,
  providerName: () => (isConfigured() ? `claude:${MODEL}` : "heuristic"),
  generateNotes,
  generateTutorial,
  generateQuiz,
  generateSummary,
  answerFromTranscript,
};
