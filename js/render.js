// Convierte texto con LaTeX (\( … \), \[ … \], $$ … $$, $ … $) en HTML listo para KaTeX.

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
const BLANK = /\[\[\s*([A-Za-z0-9]{1,3})\s*\]\]/g;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Texto del enunciado/explicación → HTML (sin renderizar aún las fórmulas). */
export function mathHTML(text) {
  const parts = String(text ?? '').split(MATH);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      html += esc(part.replace(BLANK, (_, l) => `\\boxed{\\,\\mathsf{${l.toUpperCase()}}\\,}`));
    } else {
      html += esc(part)
        .replace(BLANK, (_, l) => `\\(\\boxed{\\,\\mathsf{${l.toUpperCase()}}\\,}\\)`)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n{2,}/g, '<br><br>')
        .replace(/\n/g, '<br>');
    }
  });
  return html;
}

/** Renderiza las fórmulas dentro de un elemento ya insertado en la página. */
export function typeset(el) {
  if (!window.renderMathInElement) return;
  window.renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  });
}
