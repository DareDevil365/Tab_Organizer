import React from 'react';

interface MarkdownContentProps {
  content: string;
  sources?: Array<{
    id?: number;
    title: string;
    url: string;
    domain?: string;
    similarity_score?: number;
  }>;
  onCitationClick?: (index: number) => void;
}

/**
 * Parses inline formatting: **bold**, *italic*, `code`, and [1] citations.
 */
function parseInline(text: string, onCitationClick?: (idx: number) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex matches: **bold**, `code`, *italic*, [citation_number], [link text](url)
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[\d+\]|\[[^\]]+\]\([^)]+\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      nodes.push(text.substring(lastIndex, match.index));
    }

    const token = match[0];
    const key = `inline-${match.index}`;

    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key} style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={key}
          style={{
            background: 'var(--surface-hover)',
            border: '1px solid var(--border)',
            padding: '2px 6px',
            borderRadius: 4,
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            color: 'var(--accent)'
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key} style={{ color: 'var(--text-secondary)' }}>{token.slice(1, -1)}</em>);
    } else if (/^\[\d+\]$/.test(token)) {
      const citeNum = parseInt(token.slice(1, -1), 10);
      nodes.push(
        <button
          key={key}
          onClick={(e) => {
            e.preventDefault();
            onCitationClick?.(citeNum);
          }}
          className="citation-pill"
          title={`Jump to Source [${citeNum}]`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--accent)',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent)',
            borderRadius: 6,
            padding: '1px 5px',
            margin: '0 3px',
            cursor: 'pointer',
            verticalAlign: 'baseline',
            transition: 'all 0.15s ease'
          }}
        >
          [{citeNum}]
        </button>
      );
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.substring(lastIndex));
  }

  return nodes;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, onCitationClick }) => {
  // Strip out any trailing "Sources from your library" block if it was appended in raw text
  const cleanContent = content
    .replace(/(?:📚|🔗)?\s*Sources from your library:[\s\S]*$/i, '')
    .trim();

  const lines = cleanContent.split('\n');
  const elements: React.ReactNode[] = [];

  let currentList: { type: 'ol' | 'ul'; items: React.ReactNode[] } | null = null;

  function flushList() {
    if (!currentList) return;
    if (currentList.type === 'ol') {
      elements.push(
        <ol key={`list-${elements.length}`} style={{ margin: '8px 0 14px 20px', paddingLeft: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {currentList.items.map((it, i) => (
            <li key={i} style={{ lineHeight: 1.6, color: 'var(--text-primary)' }}>{it}</li>
          ))}
        </ol>
      );
    } else {
      elements.push(
        <ul key={`list-${elements.length}`} style={{ margin: '6px 0 12px 20px', paddingLeft: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {currentList.items.map((it, i) => (
            <li key={i} style={{ lineHeight: 1.5, color: 'var(--text-secondary)' }}>{it}</li>
          ))}
        </ul>
      );
    }
    currentList = null;
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    // Headers: ### Title
    if (/^#{1,6}\s+/.test(trimmed)) {
      flushList();
      const level = trimmed.match(/^#+/)?.[0].length || 3;
      const text = trimmed.replace(/^#+\s*/, '');
      const Tag = (level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4') as keyof JSX.IntrinsicElements;
      elements.push(
        <Tag
          key={`header-${index}`}
          style={{
            margin: '16px 0 8px 0',
            fontWeight: 700,
            color: 'var(--text-primary)',
            fontSize: level === 1 ? '1.25rem' : level === 2 ? '1.1rem' : '1rem',
            letterSpacing: '-0.01em'
          }}
        >
          {parseInline(text, onCitationClick)}
        </Tag>
      );
      return;
    }

    // Numbered list items: "1. Item" or "1. **Bold:** Item"
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (!currentList || currentList.type !== 'ol') {
        flushList();
        currentList = { type: 'ol', items: [] };
      }
      currentList.items.push(parseInline(olMatch[2], onCitationClick));
      return;
    }

    // Bullet items: "* Item" or "- Item"
    const ulMatch = trimmed.match(/^[*•-]\s+(.*)$/);
    if (ulMatch) {
      if (!currentList || currentList.type !== 'ul') {
        flushList();
        currentList = { type: 'ul', items: [] };
      }
      currentList.items.push(parseInline(ulMatch[1], onCitationClick));
      return;
    }

    // Standard paragraph
    flushList();
    elements.push(
      <p key={`p-${index}`} style={{ margin: '0 0 10px 0', lineHeight: 1.6, color: 'var(--text-primary)' }}>
        {parseInline(trimmed, onCitationClick)}
      </p>
    );
  });

  flushList();

  return <div className="markdown-body" style={{ fontSize: 14 }}>{elements}</div>;
};
