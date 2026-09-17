// Small, stroke-based controls shared by the mobile shell and dynamic cards.
// Labels are optional so decorative icons stay out of the accessibility tree.
const PATHS = {
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4L20 15"/><path d="M20 20v-5h-5"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M12 4 3.5 19h17L12 4Z"/><path d="M12 9v4M12 16h.01"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9a2.3 2.3 0 1 1 3.9 1.6c-.9.8-1.7 1.1-1.7 2.5M12 16h.01"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5H6V6h5"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  running: '<circle cx="12" cy="12" r="8.5"/><path d="m8 13 2-2 2 2 4-4"/>',
  rain: '<path d="M7 16.5a4.5 4.5 0 1 1 1.2-8.8A5.5 5.5 0 0 1 18 10.5 3.5 3.5 0 0 1 17 17H7Z"/><path d="m9 19-1 2M13 19l-1 2M17 19l-1 2"/>',
  snow: '<path d="M12 3v18M5 7l14 10M19 7 5 17M8 4l4 3 4-3M8 20l4-3 4 3"/>',
  cloud: '<path d="M7 17h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 6.2 8.2 4.5 4.5 0 0 0 7 17Z"/>',
  fog: '<path d="M5 9h14M3 13h18M6 17h12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  weekly: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>',
  camera: '<path d="M4 8h4l1.5-2h5L16 8h4v10H4V8Z"/><circle cx="12" cy="13" r="3"/>',
  pin: '<path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/>',
  locate: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
};

const quote = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function icon(name, label = '') {
  const content = PATHS[name] || PATHS.question;
  const accessible = label ? ` role="img" aria-label="${quote(label)}"` : ' aria-hidden="true" focusable="false"';
  return `<svg class="ui-icon ui-icon-${quote(name)}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"${accessible}>${content}</svg>`;
}
