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
};
