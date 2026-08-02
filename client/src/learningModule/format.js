// Formatting helpers and shared constants.
//
// Deliberately not in components/common.jsx: mixing non-component exports into
// a component module breaks React Fast Refresh for that whole file.

const RELATIVE_UNITS = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000],
];

/** "in 3 days" / "2 hours ago" without pulling in another date library. */
export function relativeTime(value) {
  if (!value) return '';
  const diff = new Date(value).getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms) return formatter.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * An ISO date as `<input type="datetime-local">` wants it: local wall-clock,
 * no zone, minute precision. `toISOString` would shift the value into UTC and
 * show the teacher a time they never typed.
 */
export function toDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function initials(name = '') {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

/** Palette offered when picking a class colour. */
export const CLASS_COLORS = [
  '#1967d2',
  '#0f9d58',
  '#d93025',
  '#f4b400',
  '#7b1fa2',
  '#00838f',
  '#e65100',
  '#455a64',
];

export const WORK_TYPE_META = {
  assignment: { icon: '📄', label: 'Assignment', colorScheme: 'blue' },
  quiz: { icon: '🧠', label: 'Quiz', colorScheme: 'purple' },
  question: { icon: '❓', label: 'Question', colorScheme: 'orange' },
  material: { icon: '📚', label: 'Material', colorScheme: 'green' },
  // Not a `workType` of its own — a coding exercise is stored as an assignment
  // carrying a `notebookId`. It reads as one on the calendar because "📄
  // Assignment due" tells a student nothing about what they have to open.
  notebook: { icon: '🐍', label: 'Coding exercise', colorScheme: 'teal' },
};

/**
 * The calendar/classwork identity of a coursework row.
 *
 * A notebook is mirrored into Classwork as an assignment so it inherits the due
 * date and the gradebook column, but on a calendar it should say what it is and
 * link to the exercise rather than to its gradebook row.
 */
export const courseworkMeta = (item) =>
  item?.notebookId ? WORK_TYPE_META.notebook : WORK_TYPE_META[item?.workType] || WORK_TYPE_META.assignment;

export const courseworkLink = (item) =>
  item?.notebookId
    ? `/learning/class/${item.classId}/notebook/${item.notebookId}`
    : `/learning/class/${item?.classId}/work/${item?._id}`;
