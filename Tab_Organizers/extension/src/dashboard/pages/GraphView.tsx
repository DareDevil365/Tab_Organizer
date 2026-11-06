import React, { useEffect, useState, useRef } from 'react';
import { apiClient } from '../../lib/api-client';

interface GraphNode {
  id: string;
  label: string;
  type: 'page' | 'domain' | 'topic' | 'category';
  url?: string;
  domain?: string;
  topic?: string;
  category?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  total_edges: number;
}

export const GraphView: React.FC = () => {
  const [data, setData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    loadGraph();
  }, []);

  async function loadGraph() {
    setLoading(true);
    try {
      const res = await apiClient.get<GraphData>('/api/graph?limit=100');
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  // Simple dynamic force/circular graph layout on 2D canvas
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Calculate circular positions
    const nodePositions: Record<string, { x: number; y: number; r: number; color: string }> = {};
    const center = { x: width / 2, y: height / 2 };

    const typeColors: Record<string, string> = {
      page: '#8ab4f8',
      domain: '#fdd663',
      topic: '#81c995',
      category: '#c58af9'
    };

    const count = data.nodes.length;
    data.nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, count)) * 2 * Math.PI;
      const radius = n.type === 'page' ? Math.min(width, height) * 0.38 : Math.min(width, height) * 0.22;
      const x = center.x + radius * Math.cos(angle) + (Math.random() * 20 - 10);
      const y = center.y + radius * Math.sin(angle) + (Math.random() * 20 - 10);
      nodePositions[n.id] = {
        x,
        y,
        r: n.type === 'page' ? 5 : 8,
        color: typeColors[n.type] || '#fff'
      };
    });

    // Draw Edges
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    data.edges.forEach(e => {
      const src = nodePositions[e.source];
      const tgt = nodePositions[e.target];
      if (src && tgt) {
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.stroke();
      }
    });

    // Draw Nodes
    data.nodes.forEach(n => {
      const pos = nodePositions[n.id];
      if (!pos) return;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, pos.r, 0, 2 * Math.PI);
      ctx.fillStyle = pos.color;
      ctx.fill();

      // Label for non-page nodes
      if (n.type !== 'page' || count < 20) {
        ctx.fillStyle = '#9098a9';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(n.label.slice(0, 14), pos.x, pos.y - pos.r - 4);
      }
    });

  }, [data]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">🕸️ Knowledge Graph</h1>
          <p style={{ color: '#9098a9', fontSize: 13, marginTop: 4 }}>
            Visual map of connections linking your saved tabs, domains, AI topics, and folders
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#8ab4f8' }} /> Saved Page
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#81c995' }} /> Topic
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#c58af9' }} /> Folder
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fdd663' }} /> Domain
          </span>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#9098a9', textAlign: 'center', marginTop: 40 }}>Constructing graph relationships...</p>
      ) : !data || data.total_nodes === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9098a9' }}>
          <h3>No graph data available</h3>
          <p style={{ fontSize: 13, marginTop: 6 }}>Save some tabs to your library first.</p>
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          justifyContent: 'center'
        }}>
          <canvas
            ref={canvasRef}
            width={850}
            height={550}
            style={{ width: '100%', maxWidth: 850, height: 'auto', background: 'transparent' }}
          />
        </div>
      )}
    </div>
  );
};
