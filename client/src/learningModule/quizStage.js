/**
 * The DOM half of the quiz stage — see `components/QuizStage.jsx` for the
 * component that renders into it.
 *
 * The host element is created once and never removed, and that is the whole
 * point: the browser drops fullscreen the instant the fullscreened element
 * leaves the DOM, so fullscreening a page's own wrapper would end the moment
 * "Start test" swapped the brief for the paper. A host that lives outside the
 * route tree survives that hop, so the student sees one uninterrupted screen
 * from the instructions to the last question.
 */

const HOST_ID = 'lm-quiz-stage';
// gray.50 — the background the rest of the module sits on.
const HOST_STYLE = 'position:fixed;inset:0;z-index:1300;overflow-y:auto;background:#F7FAFC;';

// How many quiz screens are mounted. Module scope rather than React state
// because this has to survive the handover between the two of them.
let openCount = 0;

export function getQuizStageHost() {
  let node = document.getElementById(HOST_ID);
  if (!node) {
    node = document.createElement('div');
    node.id = HOST_ID;
    node.style.cssText = `${HOST_STYLE}display:none;`;
    document.body.appendChild(node);
  }
  return node;
}

/** Fullscreens the stage. Resolves false when the browser wanted a gesture. */
export async function requestQuizFullscreen() {
  if (document.fullscreenElement) return true;
  try {
    await getQuizStageHost().requestFullscreen();
    return true;
  } catch {
    // Nothing to recover from — the stage header keeps offering the button.
    return false;
  }
}

/** The stage scrolls, not the window, so page-level scrolling goes through here. */
export function scrollStageToTop() {
  document.getElementById(HOST_ID)?.scrollTo({ top: 0 });
}

/**
 * Puts a quiz screen on the stage and returns the release function.
 *
 * The stage covers the viewport whether or not real fullscreen was granted:
 * `requestFullscreen` needs a user gesture, and a quiz opened from a pasted
 * link in a fresh tab has none. Being an overlay first and fullscreen second
 * means the test always fills the screen, and a refusal costs nothing but the
 * browser's own chrome.
 */
export function openQuizStage() {
  const host = getQuizStageHost();
  openCount += 1;
  host.style.display = 'block';
  document.body.style.overflow = 'hidden';
  // Arriving from a link click still carries that click's transient activation,
  // so this normally lands without the student doing anything.
  if (openCount === 1) requestQuizFullscreen();

  return () => {
    openCount -= 1;
    // The brief unmounts before the paper mounts; deciding a beat later keeps
    // that handover from blinking the app back into view.
    setTimeout(() => {
      if (openCount > 0) return;
      host.style.display = 'none';
      document.body.style.overflow = '';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }, 0);
  };
}
