import React, { useState, useRef, useEffect } from 'react';
import { PageData } from '../../types';

interface PageCardProps {
  page: PageData & { id?: number; tags?: string; is_important?: boolean; is_urgent?: boolean; created_at?: string };
  onToggleImportant?: (pageId: number, currentVal: boolean) => void;
  onToggleUrgent?: (pageId: number, currentVal: boolean) => void;
  onDelete?: (pageId: number) => void;
}

function extractYoutubeThumbnail(url?: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
}

function getDomainHue(domain?: string): number {
  if (!domain) return 210;
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function isMeaningfulTopic(topic?: string): boolean {
  if (!topic) return false;
  const lower = topic.trim().toLowerCase();
  return !['general', 'other', 'uncategorized', 'none', 'unknown', ''].includes(lower);
}

function initial(str?: string): string {
  return (str || '?').trim().charAt(0).toUpperCase();
}

export const PageCard: React.FC<PageCardProps> = ({
  page,
  onToggleImportant,
  onToggleUrgent,
  onDelete,
}) => {
  const targetUrl = page.url_original || page.url_normalized || '#';
  const domain = page.domain || (page.url_original ? (() => {
    try { return new URL(page.url_original).hostname.replace(/^www\./, ''); } catch { return 'external'; }
  })() : 'external');

  const rawThumb = page.og_image_data || page.og_image_url || extractYoutubeThumbnail(targetUrl);
  const [imgError, setImgError] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hue = getDomainHue(domain);
  const favicon = page.favicon_url || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleCopyLink = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(targetUrl);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setMenuOpen(false);
    }, 1200);
  };

  const handleImportantClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    if (page.id && onToggleImportant) {
      onToggleImportant(page.id, !!page.is_important);
    }
  };

  const handleUrgentClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    if (page.id && onToggleUrgent) {
      onToggleUrgent(page.id, !!page.is_urgent);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    if (page.id && onDelete) {
      onDelete(page.id);
    }
  };

  return (
    <div className="card-container">
      <a
        href={targetUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="card"
        title={page.title || targetUrl}
      >
        <div className="thumb-wrap">
          {rawThumb && !imgError ? (
            <img
              className="cover"
              src={rawThumb}
              alt=""
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            <div
              className="thumb-fallback"
              style={{
                background: `linear-gradient(135deg, hsl(${hue}, 45%, 28%), hsl(${(hue + 40) % 360}, 50%, 16%))`
              }}
            >
              {page.favicon_url ? (
                <img
                  className="favicon"
                  src={page.favicon_url}
                  alt=""
                  onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                />
              ) : (
                <span style={{ fontSize: 24, fontWeight: 700 }}>{initial(domain)}</span>
              )}
              <span className="domain-label">{domain}</span>
            </div>
          )}

          {/* Quick status icons overlaid on thumbnail */}
          <div className="thumb-badges">
            {page.is_important && <span className="thumb-badge badge-star" title="Important">★</span>}
            {page.is_urgent && <span className="thumb-badge badge-flame" title="Urgent">🔥</span>}
          </div>
        </div>

        <div className="card-row">
          <div className="avatar">
            <img
              src={favicon}
              alt=""
              onError={(e) => { (e.target as HTMLElement).src = 'public/icons/icon16.png'; }}
            />
          </div>

          <div className="card-text">
            <div className="card-title">
              {page.title || targetUrl}
            </div>

            <div className="card-meta">
              <span>{domain}</span>
              {page.description && (
                <span> · {page.description}</span>
              )}
            </div>

            <div className="card-badges-row">
              {page.is_important && (
                <span className="badge badge-important">★ Important</span>
              )}
              {page.is_urgent && (
                <span className="badge badge-urgent">🔥 Urgent</span>
              )}
              {isMeaningfulTopic(page.topic) && (
                <span className="topic-pill">#{page.topic}</span>
              )}
            </div>
          </div>

          {/* 3-dots YouTube Style Menu right beside the title */}
          <div
            className="dots-menu-wrapper"
            ref={menuRef}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              className={`dots-btn ${menuOpen ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              title="More actions"
            >
              ⋮
            </button>

            {menuOpen && (
              <div className="dots-dropdown">
                <button className="dropdown-item" onClick={handleImportantClick}>
                  <span className="item-icon">{page.is_important ? '★' : '☆'}</span>
                  <span>{page.is_important ? 'Unmark Important' : 'Mark as Important'}</span>
                </button>

                <button className="dropdown-item" onClick={handleUrgentClick}>
                  <span className="item-icon">{page.is_urgent ? '🔥' : '⚡'}</span>
                  <span>{page.is_urgent ? 'Unmark Urgent' : 'Mark as Urgent'}</span>
                </button>

                <button className="dropdown-item" onClick={handleCopyLink}>
                  <span className="item-icon">{copied ? '✓' : '📋'}</span>
                  <span>{copied ? 'Copied Link!' : 'Copy Link'}</span>
                </button>

                <div className="dropdown-divider" />

                <button className="dropdown-item dropdown-item-danger" onClick={handleDeleteClick}>
                  <span className="item-icon">🗑️</span>
                  <span>Remove Tab</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </a>
    </div>
  );
};
