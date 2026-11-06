export const GRAPH_LABEL_VIEWS = ['topics', 'short', 'titles', 'minimal'] as const;
export type GraphLabelView = typeof GRAPH_LABEL_VIEWS[number];
export const graphLabelView = (value: string | null): GraphLabelView => GRAPH_LABEL_VIEWS.includes(value as GraphLabelView) ? value as GraphLabelView : 'topics';

export function showGraphLabel(view: GraphLabelView, isPage: boolean, scale: number, emphasis: boolean): boolean {
  if (emphasis) return true;
  if (view === 'minimal') return false;
  if (!isPage) return scale > .42;
  return (view === 'short' || view === 'titles') && scale >= .85;
}

const FILLER = new Set(['the','a','an','how','to','your','you','and','or','of','for','in','on','from','with','this','that','these','those','is','are','it','its','i','my','we','our','actually','youtube']);
export function shortGraphLabel(title: string): string {
  const words = title.replace(/\s*[-|]\s*YouTube\s*$/i, '').split(/\s+/).filter(word => !FILLER.has(word.toLowerCase()) && /[\p{L}\p{N}]/u.test(word));
  const label = words.slice(0, 5).join(' ') || title;
  return label.length > 56 ? label.slice(0, 54) + '…' : label;
}

export function wrapGraphTitle(title: string, width = 36): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of title.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['Saved resource'];
}
