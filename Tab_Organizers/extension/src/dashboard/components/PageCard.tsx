import React, { useState, useRef, useEffect } from 'react';
import { PageData } from '../../types';
import { CompletionButton } from './CompletionButton';
import { coverInk } from '../../lib/cover-palette';
import { pageTopics } from '../../lib/page-filters';

interface PageCardProps {
  relevance?: number;
  page: PageData & { id?: number; tags?: string; is_important?: boolean; is_urgent?: boolean; created_at?: string };
  onToggleImportant?: (pageId: number, currentVal: boolean) => void;
  onToggleUrgent?: (pageId: number, currentVal: boolean) => void;
  onDelete?: (pageId: number) => void;
  onSelectPage?: (pageId: number) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelection?: (pageId: number) => void;
  onCompletionUpdated?: (page: PageData) => void;
}

function extractYoutubeThumbnail(url?: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
}

function isMeaningfulTopic(topic?: string): boolean {
  if (!topic) return false;
  const lower = topic.trim().toLowerCase();
  return !['general', 'other', 'uncategorized', 'none', 'unknown', ''].includes(lower);
}

export const PageCard: React.FC<PageCardProps> = ({
  relevance,
  page,
  onToggleImportant,
  onToggleUrgent,
  onDelete,
  onSelectPage,
  selectionMode = false,
  selected = false,
  onToggleSelection,
  onCompletionUpdated,
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
  const topic = page.display_topic || pageTopics(page).slice(-1)[0];
  const coverTopic = isMeaningfulTopic(topic) ? topic! : 'Saved resource';
  const ink = coverInk(coverTopic === 'Saved resource' ? page.title || '' : coverTopic);

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

  const handleOpenDetail = (e: React.MouseEvent) => {
    if(page.pendingSync&&page.id!<0){e.preventDefault();if(!selectionMode)window.open(targetUrl,'_blank','noopener');return;}
    if (selectionMode && page.id) { e.preventDefault(); onToggleSelection?.(page.id); return; }
    if (page.id && onSelectPage) {
      e.preventDefault();
      onSelectPage(page.id);
    }
  };

  return (
    <div className="card-container">
      <div
        className={`card ${selectionMode ? 'card-selectable' : ''} ${selected ? 'card-selected' : ''}`}
        data-page-id={page.id}
        title={page.title || targetUrl}
        role={onSelectPage ? 'button' : undefined}
        tabIndex={onSelectPage ? 0 : undefined}
        aria-label={`${selectionMode ? 'Select ' : ''}${page.title || targetUrl}`}
        aria-pressed={selectionMode ? selected : undefined}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (page.id) { if (selectionMode) onToggleSelection?.(page.id); else onSelectPage?.(page.id); }
          }
        }}
        style={{ cursor: onSelectPage ? 'pointer' : 'default' }}
        onClick={handleOpenDetail}
      >
        <div className="thumb-wrap">
          {relevance !== undefined && <span className="search-relevance" title="Relative relevance score out of 100, not a probability or certainty">{relevance}<small>/100</small></span>}
          {selectionMode && <span className={`card-selection-mark ${selected ? 'is-selected' : ''}`} aria-hidden="true">{selected ? '✓' : ''}</span>}
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
                background: `linear-gradient(135deg, ${ink.from}, ${ink.to})`
              }}
            >
              <span className="cover-topic">{coverTopic}</span>
              <span className="cover-title">{page.title || domain}</span>
            </div>
          )}

          {/* Quick status icons overlaid on thumbnail */}
          <div className="thumb-badges">
            {page.is_important && <span className="thumb-badge badge-star" title="Important">★</span>}
            {page.is_urgent && <span className="thumb-badge badge-flame" title="Urgent">🔥</span>}
          </div>
        </div>

        {page.pendingSync&&<small className="pending-label">Saved on device · Pending upload</small>}
        <div className="card-row">
          <div className="card-text">
            <div className="card-title">{page.title || domain}</div>
            <div className="card-meta">
              <span className="card-topic-dot" aria-hidden="true" style={{ background: ink.dot }} />
              <span>{isMeaningfulTopic(topic) ? topic : page.category || domain}</span>
              {(page.note_count || 0) > 0 && (
                <span className="card-note-count" title={`${page.note_count} saved note${page.note_count === 1 ? '' : 's'}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3h11v18H5V3h3ZM8 3v18M11 8h5m-5 4h5"/></svg>
                  {page.note_count} note{page.note_count === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>

          {!selectionMode && onCompletionUpdated && <CompletionButton page={page} onUpdated={onCompletionUpdated} />}
          {/* 3-dots YouTube Style Menu right beside the title */}
          {!selectionMode && <div
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
              aria-label={`More actions for ${page.title || domain}`}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              ⋮
            </button>

            {menuOpen && (
              <div className="dots-dropdown">
                {page.id && onSelectPage && (
                  <button className="dropdown-item" onClick={handleOpenDetail}>
                    <span className="item-icon">📝</span>
                    <span>View Notes & Assistant</span>
                  </button>
                )}

                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dropdown-item"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <span className="item-icon">↗</span>
                  <span>Open in New Tab</span>
                </a>

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
          </div>}
        </div>
      </div>
    </div>
  );
};
