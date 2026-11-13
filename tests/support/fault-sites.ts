/**
 * Generated C++ with the fault sites of array accesses taken out:
 * `strucpp::iec_at(ARR, strucpp::iec_site{"MAIN", 4}, I)` reads `ARR.at(I)`,
 * so assertions about the access itself need not repeat the POU and line.
 */
export function withoutSites(cpp: string): string {
  const head = "strucpp::iec_at(";
  let out = cpp;
  for (;;) {
    const start = out.indexOf(head);
    if (start < 0) return out;
    // The three parts: container, site, indices (to the matching parenthesis)
    let depth = 1;
    let i = start + head.length;
    const commas: number[] = [];
    for (; i < out.length && depth > 0; i++) {
      const c = out[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === "," && depth === 1 && commas.length < 2) commas.push(i);
    }
    const end = i - 1;
    const container = out.slice(start + head.length, commas[0]);
    const indices = out.slice(commas[1]! + 1, end).trim();
    out = `${out.slice(0, start)}${container}.at(${indices})${out.slice(end + 1)}`;
  }
}
