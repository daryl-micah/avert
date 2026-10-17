// Explainability: every tool result carries the path it used, as ordered steps with file and line.

export interface Step {
  kind: string;              // node label
  id: string;
  label: string;             // human-readable
  file?: string;
  line?: number;
  edge?: string;             // edge to the next step, e.g. "-AFFECTS->" or "<-PASSES-"
}

export interface GNode { labels: string[]; properties: Record<string, any> }
export interface GEdge { relationshipType: string }

export function step(n: GNode): Step {
  const p = n.properties;
  const kind = n.labels[0];
  const s: Step = { kind, id: p.id, label: p.id };
  switch (kind) {
    case 'ChangeEvent': s.label = `${p.kind}: ${p.summary}`; break;
    case 'Value': s.label = `"${p.value}"${p.pinned ? '' : ' (unpinned alias)'}`; break;
    case 'CallSite': s.label = p.snippet; s.file = p.file; s.line = p.line; break;
    case 'Function': s.label = `${p.name}()`; s.file = p.file; s.line = p.line; break;
    case 'Route': s.label = `${p.method} ${p.path}`; s.file = p.file; s.line = p.line; break;
    case 'Team': s.label = p.handle; break;
  }
  return s;
}

/** Steps for nodes walked in edge direction (a -R-> b). */
export function forward(nodes: GNode[], edges: GEdge[]): Step[] {
  return nodes.map((n, i) => ({ ...step(n), ...(i < edges.length ? { edge: `-${edges[i].relationshipType}->` } : {}) }));
}

/** Steps for nodes walked against edge direction: given path a -R-> b -S-> c, returns c <-S- b <-R- a. */
export function backward(nodes: GNode[], edges: GEdge[]): Step[] {
  const n = [...nodes].reverse();
  const e = [...edges].reverse();
  return n.map((x, i) => ({ ...step(x), ...(i < e.length ? { edge: `<-${e[i].relationshipType}-` } : {}) }));
}

/** Join path segments that share their boundary node (the last step of one is the first of the next). */
export function join(...segments: Step[][]): Step[] {
  const out: Step[] = [];
  for (const seg of segments.filter((s) => s.length)) {
    if (out.length && out[out.length - 1].id === seg[0].id) {
      const last = out.pop()!;
      out.push({ ...last, edge: seg[0].edge });
      out.push(...seg.slice(1));
    } else out.push(...seg);
  }
  return out;
}

/** One line per step, for CLI output and issue bodies. */
export function render(path: Step[]): string {
  return path.map((s) => `${s.kind.padEnd(11)} ${s.label}${s.file ? `  (${s.file}${s.line ? `:${s.line}` : ''})` : ''}${s.edge ? `\n${' '.repeat(12)}${s.edge}` : ''}`).join('\n');
}
