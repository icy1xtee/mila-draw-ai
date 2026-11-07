// Small, safe Markdown renderer for the task journal (notes.md written by Claude).
// HTML in the source is escaped; links to task files become links to /files/.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inline(text, base) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${link(url, base)}" target="_blank">${label}</a>`);
  // Bare file paths of the task (outputs/x.png, inputs/y.jpg) become links.
  s = s.replace(/(^|[\s(>])((?:outputs|inputs)\/[\w.\-]+\.(?:png|jpe?g|webp|gif))/g, (_, pre, path) => `${pre}<a href="${link(path, base)}" target="_blank">${path}</a>`);
  return s;
}

function link(url, base) {
  const raw = url.replace(/&amp;/g, "&");
  if (/^https?:\/\//.test(raw)) return raw;
  const path = (base + raw.replace(/^\.\//, "")).split("/").map(encodeURIComponent).join("/");
  return `/files/${path}`;
}

export function renderMarkdown(source, base = "") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), base)}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      closeList();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inline(heading[2], base)}</h${level}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(
        `<table>${body
          .map((r, n) => `<tr>${cells(r).map((c) => (n === 0 ? `<th>${inline(c, base)}</th>` : `<td>${inline(c, base)}</td>`)).join("")}</tr>`)
          .join("")}</table>`,
      );
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      flushPara();
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(item[2], base)}</li>`);
      continue;
    }
    if (line.startsWith(">")) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""), base)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim(), base)}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}
