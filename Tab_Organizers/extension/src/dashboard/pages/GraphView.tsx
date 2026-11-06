import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph, { LinkObject } from 'force-graph';
import { cacheForBackend } from '../../lib/outbox';
import { apiClient } from '../../lib/api-client';
import { branchFocus } from '../../lib/graph-focus';
import { cameraLimits, keepGraphVisible } from '../../lib/graph-camera';
import { GraphLabelView, graphLabelView, showGraphLabel, shortGraphLabel, wrapGraphTitle } from '../../lib/graph-labels';

export interface GraphNode {
  id: string; label: string; type: 'page' | 'topic' | 'category';
  page_id?: number; parent_id?: string | null; parent_ids?: string[]; depth?: number; description?: string; resource_count?: number;
  x?: number; y?: number; fx?: number; fy?: number; color?: string;
}
export interface GraphEdge { source: string; target: string; type: string }
export interface GraphData { schema?: string; nodes: GraphNode[]; edges: GraphEdge[]; total_nodes: number; total_edges: number; resource_count?: number; total_resources?: number; is_truncated?: boolean; cross_connections?: number; discovery_mode?: string; heading_mode?: string }
type RenderLink = LinkObject<GraphNode> & { type: string };
const GENERATIONS = ['#eee8db', '#d6b77e', '#8abbd0', '#8dc2aa', '#d89e88', '#a8b782'];
const generationColor = (depth: number) => GENERATIONS[depth] || `hsl(${(depth * 47) % 360} 75% 68%)`;
const nodeValue = (node: GraphNode) => Math.max(1, 16 * Math.pow(.58, node.depth || 0)) * (node.type === 'page' ? .7 : 1);

/** Organic subject clusters are laid out once, then pinned: no moving physics. */
function placeBranches(input: GraphNode[]): GraphNode[] {
  const nodes = input.map(n => ({ ...n }));
  const children = new Map<string, GraphNode[]>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  nodes.forEach(n => { if (n.parent_id && byId.has(n.parent_id)) children.set(n.parent_id, [...(children.get(n.parent_id) || []), n]); });
  children.forEach(list => list.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)));
  const seed = (key: string) => {
    let value = 2166136261;
    for (const character of key) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
    return (value >>> 0) / 4294967295;
  };
  const visited = new Set<string>();
  const roots = nodes.filter(n => !n.parent_id || !byId.has(n.parent_id));
  const assign = (node: GraphNode, x: number, y: number, angle: number, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    node.x = x; node.y = y; node.depth = depth; node.color = generationColor(depth);
    const list = children.get(node.id) || [];
    const onlyPages = list.every(child => child.type === 'page');
    list.forEach((child, i) => {
      const random = seed(child.id);
      let direction: number, distance: number;
      if (depth === 0) {
        direction = i * Math.PI * 2 / Math.max(1, list.length) - .72 + (random - .5) * .22;
        distance = 150 + Math.sqrt(nodes.length) * 4 + random * 50;
      } else if (onlyPages) {
        // A loose sunflower cluster around the subject, rather than another ring.
        direction = angle + i * 2.3999632297 + (random - .5) * .4;
        distance = 35 + Math.sqrt(i + 1) * 23 + random * 12;
      } else {
        direction = angle + (i - (list.length - 1) / 2) * Math.min(.85, 2.1 / Math.max(1, list.length - 1)) + (random - .5) * .28;
        distance = 105 + Math.sqrt(children.get(child.id)?.length || 1) * 11 + random * 27;
      }
      const centerX = onlyPages && depth > 0 ? x + Math.cos(angle) * 36 : x;
      const centerY = onlyPages && depth > 0 ? y + Math.sin(angle) * 36 : y;
      assign(child, centerX + Math.cos(direction) * distance, centerY + Math.sin(direction) * distance * .86,
        direction, depth + 1);
    });
  };
  roots.forEach((root, index) => assign(root, index * 500, 0, -.72, 0));
  // Malformed orphan cycles must still remain inspectable.
  nodes.filter(n => !visited.has(n.id)).forEach((node, index) => assign(node, 180 + index * 45, 300, 0, 1));
  // A resource has one stable position, with its secondary connections drawing
  // it toward the space between communities instead of duplicating the video.
  nodes.filter(node => node.type === 'page' && (node.parent_ids?.length || 0) > 1).forEach(node => {
    const parents = node.parent_ids!.map(id => byId.get(id)).filter((parent): parent is GraphNode => !!parent);
    if (!parents.length) return;
    node.x = node.x! * .65 + parents.reduce((sum,parent) => sum + parent.x!, 0) / parents.length * .35;
    node.y = node.y! * .65 + parents.reduce((sum,parent) => sum + parent.y!, 0) / parents.length * .35;
  });
  // Resolve local overlaps before the first paint. This is a bounded calculation,
  // never a running simulation; branch positions stay identical across visits.
  for (let pass = 0; pass < 45; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const gap = (a.type === 'page' ? 12 : 25) + (b.type === 'page' ? 12 : 25);
        let dx = b.x! - a.x!, dy = b.y! - a.y!;
        let distance = Math.hypot(dx, dy);
        if (distance >= gap) continue;
        if (distance < .01) { dx = Math.cos(seed(a.id + b.id) * Math.PI * 2); dy = Math.sin(seed(a.id + b.id) * Math.PI * 2); distance = 1; }
        const shift = (gap - distance) * .52;
        const ax = a.depth === 0 ? 0 : b.depth === 0 ? 1 : .5;
        const bx = b.depth === 0 ? 0 : a.depth === 0 ? 1 : .5;
        a.x! -= dx / distance * shift * ax; a.y! -= dy / distance * shift * ax;
        b.x! += dx / distance * shift * bx; b.y! += dy / distance * shift * bx;
        moved = true;
      }
    }
    if (!moved) break;
  }
  nodes.forEach(node => { node.fx = node.x; node.fy = node.y; });
  return nodes;
}

export const GraphView: React.FC<{ onSelectPage?: (id: number) => void }> = ({ onSelectPage }) => {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<GraphNode, RenderLink> | null>(null);
  const fitCamera = useRef<() => void>(() => {});
  const [labelView, setLabelView] = useState<GraphLabelView>(() => {
    try { return graphLabelView(localStorage.getItem('karlx-graph-label-view')); } catch { return 'topics'; }
  });
  const paint = useRef<{ focus: Set<string> | null; selected: string | null; hover: string | null; query: string; labelView: GraphLabelView }>({ focus: null, selected: null, hover: null, query: '', labelView });
  const [data, setData] = useState<GraphData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinnedBubble, setPinnedBubble] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [bubblePosition, setBubblePosition] = useState({ x: 20, y: 20 });
  const interaction = useRef<{ selected: string | null; pinned: string | null }>({ selected: null, pinned: null });
  const renderNodes = useRef<GraphNode[]>([]);
  const pointerDown = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverDismiss = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  const scheduleHoverDismiss = useCallback(() => {
    cancelHoverDismiss();
    hoverTimer.current = setTimeout(() => setHovered(null), 140);
  }, [cancelHoverDismiss]);
  const bubbleId = pinnedBubble || (hovered !== selected ? hovered : null);
  const bubbleRef = useRef<string | null>(null);
  bubbleRef.current = bubbleId;
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(()=>{const refresh=()=>setRevision(value=>value+1);window.addEventListener('resources-restored',refresh);return()=>window.removeEventListener('resources-restored',refresh);},[]);
  useEffect(()=>{if(data)void cacheForBackend('graph',data);},[data]);
  const selectedNode = data?.nodes.find(n => n.id === selected);
  const bubbleNode = data?.nodes.find(n => n.id === bubbleId);
  const hierarchy = useMemo(() => {
    const byId = new Map((data?.nodes || []).map(node => [node.id, node]));
    const paths = new Map<string, GraphNode[]>();
    byId.forEach(node => {
      const path: GraphNode[] = [], seen = new Set<string>();
      let current: GraphNode | undefined = node;
      while (current && !seen.has(current.id)) {
        seen.add(current.id); path.unshift(current);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
      paths.set(node.id, path);
    });
    return paths;
  }, [data]);
  const levels = [...new Set([...hierarchy.values()].map(path => path.length - 1))].sort((a, b) => a - b);
  const bubblePath = bubbleNode ? hierarchy.get(bubbleNode.id) || [bubbleNode] : [];
  const bubbleLevel = Math.max(0, bubblePath.length - 1);
  const selectNode = useCallback((id: string | null) => {
    cancelHoverDismiss();
    const previous = interaction.current;
    const pinned = id && (id !== previous.selected || previous.pinned !== id) ? id : null;
    interaction.current = { selected: id, pinned };
    setSelected(id); setPinnedBubble(pinned);
    if (!id) setHovered(null);
  }, [cancelHoverDismiss]);
  const focusResult=(id:string)=>{
    selectNode(id);setQuery('');const node=renderNodes.current.find(node=>node.id===id),instance=graph.current;
    if(node&&instance){const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:240;instance.centerAt(node.x!,node.y!,duration).zoom(Math.max(instance.zoom(),.95),duration);}
  };
  const hideBubble = useCallback(() => {
    interaction.current.pinned = null;
    setPinnedBubble(null); setHovered(null);
  }, []);
  const removeResource = async (node: GraphNode) => {
    if(!node.page_id || removing!==null)return;
    setRemoving(node.page_id);setActionError('');
    try {
      await apiClient.delete(`/api/pages/${node.page_id}`);
      selectNode(null);
      setData(previous=>{
        if(!previous)return previous;
        const keep=new Set(previous.nodes.filter(item=>item.id!==node.id).map(item=>item.id));
        // Empty generated headings disappear with their last resource. Other
        // communities retain their positions, links and current camera.
        let changed=true;
        while(changed){changed=false;for(const item of previous.nodes){
          if(!keep.has(item.id)||item.type==='page'||!item.parent_id)continue;
          if(!previous.edges.some(edge=>edge.source===item.id&&keep.has(edge.target))){keep.delete(item.id);changed=true;}
        }}
        const nodes=previous.nodes.filter(item=>keep.has(item.id)),edges=previous.edges.filter(edge=>keep.has(edge.source)&&keep.has(edge.target));
        return {...previous,nodes,edges,total_nodes:nodes.length,total_edges:edges.length,resource_count:nodes.filter(item=>item.type==='page').length,total_resources:Math.max(0,(previous.total_resources || previous.resource_count || 1)-1),cross_connections:edges.filter(edge=>edge.type==='related_topic').length};
      });
    }catch{setActionError('Could not remove this resource. Please try again.');}
    finally{setRemoving(null);}
  };
  const positionBubble = useCallback(() => {
    const node = renderNodes.current.find(n => n.id === bubbleRef.current);
    const instance = graph.current, host = container.current;
    if (!node || !instance || !host) return;
    const point = instance.graph2ScreenCoords(node.x!, node.y!);
    const bubble = host.parentElement?.querySelector<HTMLElement>('.map-node-bubble');
    const width = bubble?.offsetWidth || 280, height = bubble?.offsetHeight || 190;
    setBubblePosition({ x: Math.max(12, Math.min(point.x + 20, host.clientWidth - width - 12)), y: Math.max(12, Math.min(point.y - 28, host.clientHeight - height - 12)) });
  }, []);
  // Hit-test current coordinates directly; the renderer's color picker updates
  // on its next animation frame and can otherwise retain a stale hover target.
  const hitTest = useCallback((host: HTMLDivElement, clientX: number, clientY: number) => {
    const instance = graph.current;
    if (!instance) return null;
    const bounds = host.getBoundingClientRect();
    const point = instance.screen2GraphCoords(clientX - bounds.left, clientY - bounds.top);
    const scale = instance.zoom();
    let nearest: GraphNode | null = null, nearestDistance = Infinity;
    for (const node of renderNodes.current) {
      const radius = Math.max(6 / scale, 3 * Math.sqrt(nodeValue(node)));
      const distance = Math.hypot(point.x - node.x!, point.y - node.y!);
      if (distance <= radius && distance < nearestDistance) { nearest = node; nearestDistance = distance; }
    }
    return nearest;
  }, []);
  const trackPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const down = pointerDown.current;
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true;
    if (event.buttons) return;
    const nearest = hitTest(event.currentTarget, event.clientX, event.clientY);
    if (nearest) { cancelHoverDismiss(); setHovered(nearest.id); }
    else if (!hoverTimer.current) scheduleHoverDismiss();
    event.currentTarget.style.cursor = nearest ? 'pointer' : 'grab';
  }, [cancelHoverDismiss, scheduleHoverDismiss, hitTest]);
  const clickCanvas = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const down = pointerDown.current;
    pointerDown.current = null;
    if (down && (down.moved || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5)) return;
    selectNode(hitTest(event.currentTarget, event.clientX, event.clientY)?.id || null);
  }, [hitTest, selectNode]);

  useEffect(() => { positionBubble(); }, [bubbleId, positionBubble]);
  useEffect(() => cancelHoverDismiss, [cancelHoverDismiss]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') selectNode(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectNode]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); selectNode(null);
    void (async()=>{
      const cached=await cacheForBackend<GraphData>('graph');
      if(cached&&!controller.signal.aborted){setData(cached);setLoading(false);}
      try{
        const result=await apiClient.get<GraphData>('/api/graph');
        if(controller.signal.aborted)return;
        if(result.schema!=='connections-v1'||result.nodes.some(node=>String(node.type)==='domain'))throw new Error('Update the backend to load the current knowledge graph.');
        setData(previous=>JSON.stringify(previous)===JSON.stringify(result)?previous:result);await cacheForBackend('graph',result);
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Could not refresh your topics. Showing the last saved map.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (!container.current || !data?.nodes.length) return;
    const host = container.current;
    const instance = new ForceGraph<GraphNode, RenderLink>(host);
    graph.current = instance;
    const nodes = placeBranches(data.nodes);
    renderNodes.current = nodes;
    let cameraReady = false, adjustingCamera = false;
    const fitView = () => {
      if (host.clientWidth <= 0) return;
      const limits = cameraLimits(renderNodes.current as (GraphNode & {x:number;y:number})[], host.clientWidth, host.clientHeight);
      adjustingCamera = true;
      instance.minZoom(limits.minZoom).maxZoom(limits.maxZoom);
      instance.centerAt(limits.center.x, limits.center.y, 0).zoom(limits.fitZoom, 0);
      cameraReady = true; adjustingCamera = false; positionBubble();
    };
    fitCamera.current = fitView;
    const endpoint = (n: string | number | GraphNode | undefined) => typeof n === 'object' ? n.id : String(n);
    instance.width(host.clientWidth).height(570).backgroundColor('rgba(0,0,0,0)')
      .warmupTicks(0).cooldownTicks(0).enableNodeDrag(false)
      .nodeRelSize(3).nodeVal(nodeValue)
      .nodeLabel(() => '')
      .nodeColor(n => paint.current.focus && !paint.current.focus.has(n.id) ? 'rgba(119,119,131,.23)' : n.color!)
      .linkColor(link => {
        const focus = paint.current.focus;
        const related = link.type === 'related_topic';
        return focus ? focus.has(endpoint(link.source)) && focus.has(endpoint(link.target)) ? related ? '#8dc2aa' : '#b4bbac' : 'rgba(125,125,140,.045)' : related ? 'rgba(141,194,170,.32)' : 'rgba(165,169,193,.18)';
      })
      .linkWidth(link => paint.current.focus?.has(endpoint(link.source)) && paint.current.focus.has(endpoint(link.target)) ? 1.4 : .6)
      .nodeCanvasObjectMode(() => 'after')
      .nodeCanvasObject((node, ctx, scale) => {
        const p = paint.current, active = !p.focus || p.focus.has(node.id);
        const match = !!p.query && node.label.toLowerCase().includes(p.query);
        const emphasis = p.selected === node.id || p.hover === node.id || match;
        if (emphasis && active) {
          ctx.save();
          ctx.beginPath(); ctx.arc(node.x!, node.y!, 3 * Math.sqrt(nodeValue(node)) + 4 / scale, 0, 2 * Math.PI);
          if (p.selected === node.id) { ctx.shadowColor = node.color || '#a78bfa'; ctx.shadowBlur = 14 / scale; }
          ctx.strokeStyle = '#e5d6ff'; ctx.lineWidth = 1.5 / scale; ctx.stroke();
          ctx.restore();
        }
        if (!active || !(showGraphLabel(p.labelView, node.type === 'page', scale, emphasis)||(p.labelView!=='minimal'&&node.type!=='page'&&(node.depth||0)<=1))) return;
        ctx.font = `${(node.type === 'page' ? 11 : 12) / scale}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        const label = node.type === 'page' && p.labelView === 'short' ? shortGraphLabel(node.label) : node.label;
        const lines = node.type === 'page' && p.labelView === 'titles' ? wrapGraphTitle(label) : [label.length > 56 ? label.slice(0, 54) + '…' : label];
        const bottom = node.y! - 3 * Math.sqrt(nodeValue(node)) - 5 / scale;
        lines.forEach((line, index) => {
          const y = bottom - (lines.length - index - 1) * 14 / scale;
          const width = ctx.measureText(line).width;
          ctx.fillStyle = 'rgba(10,10,12,.88)'; ctx.fillRect(node.x! - width / 2 - 3 / scale, y - 14 / scale, width + 6 / scale, 15 / scale);
          ctx.fillStyle = emphasis ? '#f0e8ff' : '#bdb9ca'; ctx.fillText(line, node.x!, y);
        });
      })
      .onNodeHover(n => {
        cancelHoverDismiss();
        if (n) setHovered(n.id);
        else scheduleHoverDismiss();
        host.style.cursor = n ? 'pointer' : 'grab';
      })
      .onZoom(() => {
        if (cameraReady && !adjustingCamera) {
          const center = instance.centerAt();
          const bounded = keepGraphVisible(center, instance.zoom(), renderNodes.current as (GraphNode & {x:number;y:number})[], host.clientWidth, host.clientHeight);
          if (Math.abs(bounded.x - center.x) > .01 || Math.abs(bounded.y - center.y) > .01) {
            adjustingCamera = true; instance.centerAt(bounded.x, bounded.y, 0); adjustingCamera = false;
          }
        }
        positionBubble();
      })
      .graphData({ nodes, links: data.edges.map(e => ({ ...e })) });
    let resizeFit = 0;
    let previousWidth = host.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = host.clientWidth;
      instance.width(width);
      if (width !== previousWidth) {
        previousWidth = width;
        cancelAnimationFrame(resizeFit);
        resizeFit = requestAnimationFrame(fitView);
      } else positionBubble();
    }); observer.observe(host);
    const fit = requestAnimationFrame(fitView);
    return () => { cancelAnimationFrame(fit); cancelAnimationFrame(resizeFit); observer.disconnect(); instance._destructor(); graph.current = null; fitCamera.current = () => {}; };
  }, [!!data]);

  useEffect(()=>{
    const instance=graph.current;if(!instance||!data)return;
    const old=new Map(renderNodes.current.map(node=>[node.id,node]));
    const additions=data.nodes.filter(node=>!old.has(node.id));
    const added=new Map(placeBranches(additions).map(node=>[node.id,node]));
    const nodes=data.nodes.map(node=>({...node,...(old.get(node.id)?{x:old.get(node.id)!.x,y:old.get(node.id)!.y,fx:old.get(node.id)!.fx,fy:old.get(node.id)!.fy}:added.get(node.id)),...node,color:generationColor(node.depth||0)}));
    renderNodes.current=nodes;
    instance.graphData({nodes,links:data.edges.map(edge=>({...edge}))});
    positionBubble();
  },[data,positionBubble]);

  useEffect(() => {
    paint.current.focus = branchFocus(data?.nodes || [], selected);
    paint.current.selected = selected; paint.current.hover = hovered; paint.current.query = query.trim().toLowerCase();
    paint.current.labelView = labelView;
    const instance = graph.current;
    if (instance) {
      // Accessor changes request a redraw without rebuilding or reheating layout.
      instance.nodeColor(n => paint.current.focus && !paint.current.focus.has(n.id) ? 'rgba(119,119,131,.23)' : n.color!);
    }
  }, [data, selected, query, hovered, labelView]);

  return <div className="knowledge-map-page">
    <div className="page-header"><div><h1 className="page-title">Your knowledge</h1><p>Follow an idea. Find what connects.</p></div>
      </div>
    <div className="map-toolbar">
      <div className="map-search"><input className="search-bar" aria-label="Find a topic or resource" placeholder="Find a topic or resource…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={event=>{if(event.key==='Enter'){const node=data?.nodes.find(node=>node.label.toLowerCase().includes(query.toLowerCase()));if(node)focusResult(node.id);}}}/>
      {query.trim()&&<div className="map-search-results" role="listbox" aria-label="Graph search results">{data?.nodes.filter(node=>node.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0,30).map(node=><button role="option" aria-selected={selected===node.id} key={node.id} onClick={()=>focusResult(node.id)}><strong>{node.label}</strong><small>{(hierarchy.get(node.id)||[]).slice(1,-1).map(parent=>parent.label).join(' › ')||'Library'}</small></button>)}{!data?.nodes.some(node=>node.label.toLowerCase().includes(query.trim().toLowerCase()))&&<p>No matching topic or resource</p>}</div>}</div>
      <select aria-label="Focus graph node" value={selected || ''} onChange={e=>e.target.value?focusResult(e.target.value):selectNode(null)}><option value="">All subjects</option>
        {data?.nodes.filter(n => !query || n.label.toLowerCase().includes(query.toLowerCase())).map(n => <option key={n.id} value={n.id}>{n.parent_id ? (hierarchy.get(n.id) || [n]).slice(1).map(node => node.label).join(' › ') : n.label}</option>)}
      </select>
      <select aria-label="Graph labels" title="Resource labels appear when you zoom in. This choice is remembered."
        value={labelView} onChange={event => {
          const next = graphLabelView(event.target.value); setLabelView(next);
          try { localStorage.setItem('karlx-graph-label-view', next); } catch { /* Current view still works without storage. */ }
        }}>
        <option value="topics">Topic labels</option><option value="short">Short labels when zoomed</option><option value="titles">Titles when zoomed</option><option value="minimal">Minimal labels</option>
      </select>
      <button className="pill" onClick={() => fitCamera.current()}>Fit view</button>
    </div>
    {!!levels.length && <div className="map-generation-legend" aria-label="Graph hierarchy colors. Larger nodes are higher in the hierarchy.">
      {levels.map(level => <span key={level} title={level ? `Level ${level} · smaller nodes are deeper in the hierarchy` : 'Library · root of your knowledge'}><i aria-hidden="true" style={{ backgroundColor: generationColor(level) }} />{level ? `Level ${level}` : 'Library'}</span>)}
      <small className="map-count">{data ? `${data.resource_count ?? data.nodes.filter(node => node.type === 'page').length}${data.is_truncated ? ` of ${data.total_resources}` : ''} resources · ${data.total_edges} connections · ${data.cross_connections || 0} cross-links` : ''}</small>
    </div>}
    {loading && <p role="status">{data?'Updating connections…':'Loading your topics…'}</p>}
    {error && <div className="connection-notice" role="alert"><span>{error}</span><button className="pill" onClick={() => setRevision(r => r + 1)}>Retry</button></div>}
    {actionError && <p role="alert">{actionError}</p>}
    {!loading && !error && !data?.nodes.length && <div className="empty-state">Save a few resources to start your map.</div>}
    <div className="map-canvas-wrap" hidden={!data?.nodes.length}>
      <div ref={container} className="map-canvas" role="img" aria-label="Subject graph. Use Focus graph node for keyboard navigation."
        onPointerDownCapture={event => { pointerDown.current = { x: event.clientX, y: event.clientY, moved: false }; }}
        onPointerMoveCapture={trackPointer} onClickCapture={clickCanvas}
        onPointerCancel={() => { pointerDown.current = null; }} onPointerLeave={scheduleHoverDismiss} />
      <button className="icon-btn map-clear" aria-label="Clear graph selection" title="Clear selection (Esc)" onClick={() => selectNode(null)}>↺</button>
      <div className="map-zoom"><button className="map-reset-view" onClick={() => fitCamera.current()}>Reset view</button><button className="icon-btn" aria-label="Zoom out" onClick={() => graph.current?.zoom((graph.current?.zoom() || 1) / 1.3, 0)}>−</button><button className="icon-btn" aria-label="Zoom in" onClick={() => graph.current?.zoom((graph.current?.zoom() || 1) * 1.3, 0)}>+</button></div>
      {bubbleNode && <div className="map-node-bubble" data-node-id={bubbleNode.id} role="dialog" aria-label={`Details: ${bubbleNode.label}`} style={{ left: bubblePosition.x, top: bubblePosition.y }}
        onPointerEnter={cancelHoverDismiss} onPointerLeave={() => { if (!pinnedBubble) setHovered(null); }}
        onClick={event => { event.stopPropagation(); if (!pinnedBubble && !(event.target as HTMLElement).closest('button')) selectNode(bubbleNode.id); }}>
        <button className="map-node-bubble-close" aria-label="Hide node details" onClick={hideBubble}>×</button>
        <span className="map-node-bubble-kind">{bubbleLevel ? `Level ${bubbleLevel}` : 'Library'} · {bubbleNode.type === 'page' ? 'Saved resource' : 'Subject'}{pinnedBubble ? ' · Pinned' : ''}</span>
        <h2 className="map-node-bubble-title">{bubbleNode.label}</h2>
        <p className="map-node-bubble-path" aria-label="Path in your knowledge graph">{bubblePath.map(node => node.label).join(' › ')}</p>
        {bubbleNode.type === 'page' && !!bubbleNode.parent_ids?.length && <div className="map-related-topics" aria-label="Connected topics">
          {bubbleNode.parent_ids.map(id => <button key={id} className="pill" onClick={() => selectNode(id)}>{data?.nodes.find(node => node.id === id)?.label}</button>)}
        </div>}
        {bubbleNode.type==='page'&&<details className="connection-reasons"><summary>Why these connections?</summary>{data?.edges.filter(edge=>edge.target===bubbleNode.id).map(edge=><p key={edge.source}>{data.nodes.find(node=>node.id===edge.source)?.label}: {(edge as any).basis||'Related saved content'}</p>)}</details>}
        {bubbleNode.description && <p className="map-node-bubble-description">{bubbleNode.description}</p>}
        <div className="map-node-bubble-actions">
          {bubbleNode.page_id && <button className="pill" onClick={() => onSelectPage?.(bubbleNode.page_id!)}>Preview resource</button>}
          {bubbleNode.page_id && <button className="pill" disabled={removing!==null} title="Move this resource and its notes to the five-day recycle bin" onClick={()=>void removeResource(bubbleNode)}>{removing===bubbleNode.page_id?'Removing…':'Remove from library'}</button>}
          {!pinnedBubble && <button className="pill" onClick={() => selectNode(bubbleNode.id)}>Keep open</button>}
        </div>
      </div>}
    </div>
    <div className="map-selection" aria-live="polite"><span>{selectedNode ? selectedNode.label : 'Click empty space to clear focus. Drag to pan; scroll to zoom. Layout stays still.'}</span>
      {selectedNode && <button className="pill map-selection-details" aria-expanded={pinnedBubble === selected} onClick={() => selectNode(selected)}>{pinnedBubble === selected ? 'Hide details' : 'Show details'}</button>}
    </div>
  </div>;
};
