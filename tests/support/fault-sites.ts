/**
 * Generated C++ with the fault sites taken out, so assertions about an access
 * need not repeat the POU and line:
 * - `strucpp::iec_at(ARR, strucpp::iec_site{"MAIN", 4}, I)` reads `ARR.at(I)`;
 * - `strucpp::iec_deref(P, strucpp::iec_site{...})` reads `(*P)`;
 * - `strucpp::iec_ref(R, "R", strucpp::iec_site{...})` reads `R.target()`.
 */
export function withoutSites(cpp: string): string {
  let out = cpp;
  out = rewriteCalls(out, "strucpp::iec_at(", (parts) => {
    const [container, , ...indices] = parts;
    return `${container}.at(${indices.join(", ")})`;
  });
  out = rewriteCalls(out, "strucpp::iec_deref(", (parts) => `(*${parts[0]})`);
  out = rewriteCalls(out, "strucpp::iec_ref(", (parts) => `${parts[0]}.target()`);
  return out;
}

/** Replace each call `head...)` by `render(arguments)`, innermost last. */
function rewriteCalls(
  cpp: string,
  head: string,
  render: (parts: string[]) => string,
): string {
  let out = cpp;
  for (;;) {
    const start = out.lastIndexOf(head);
    if (start < 0) return out;
    let depth = 1;
    let i = start + head.length;
    const parts: string[] = [];
    let partStart = i;
    for (; i < out.length && depth > 0; i++) {
      const c = out[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === "," && depth === 1) {
        parts.push(out.slice(partStart, i).trim());
        partStart = i + 1;
      }
    }
    parts.push(out.slice(partStart, i - 1).trim());
    out = `${out.slice(0, start)}${render(parts)}${out.slice(i)}`;
  }
}
