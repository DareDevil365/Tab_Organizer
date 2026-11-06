import React, { useState, useEffect, useRef } from 'react';
import { apiClient } from '../../lib/api-client';
import { PageData, CompanionNote } from '../../types';
import { CompletionButton } from '../components/CompletionButton';
import { useNoteDraft } from '../useNoteDraft';
import { pendingSaves, saveOnDevice, onDeviceSync, cacheForBackend } from '../../lib/outbox';
import { parseNote } from '../../lib/note-data';

interface PageDetailProps {
  initialNoteId?:string;
  pageId: number;
  onBack: () => void;
  onRefresh?: () => void;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  time: string;
}

function extractYoutubeId(url?: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

export const PageDetail: React.FC<PageDetailProps> = ({ pageId, initialNoteId, onBack, onRefresh }) => {
  const [page, setPage] = useState<PageData | null>(null);
  const [notes, setNotes] = useState<CompanionNote[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState('');

  // New Comment state
  const {text:commentText,setText:setCommentText,attachments,setAttachments}=useNoteDraft(String(pageId));
  const noteSaveLock=useRef(false);
  const [savingNote, setSavingNote] = useState<boolean>(false);
  const [showAttachMenu, setShowAttachMenu] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Assistant Bubble State
  const [isAssistantOpen, setIsAssistantOpen] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [askingAssistant, setAskingAssistant] = useState<boolean>(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(loading||!initialNoteId)return;
    const element=document.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(initialNoteId)}"]`);
    element?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    element?.classList.add('highlighted-note');
  },[loading,initialNoteId]);

  useEffect(() => {
    loadPageDetails();
  }, [pageId]);

  useEffect(()=>{
    if(!page)return;
    const update=()=>{void Promise.all([apiClient.get<any[]>(`/api/companion?page_id=${pageId}&limit=1000`),pendingSaves()]).then(([remote,jobs])=>{
      const removes=new Set(jobs.filter(job=>job.kind==='remove-note').map(job=>job.payload.id));
      const merged=new Map(remote.filter(note=>!removes.has(note.id)).map(note=>[note.id,parseNote(note)]));
      jobs.filter(job=>job.kind==='note'&&job.payload.video_url===page.url_original).forEach(job=>merged.set(job.payload.id,{...parseNote(job.payload),pendingSync:true}));
      setNotes([...merged.values()].sort((a,b)=>b.createdAt-a.createdAt));onRefresh?.();
    }).catch(()=>{});};
    return onDeviceSync(update);
  },[page?.url_original,pageId]);

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, askingAssistant]);

  async function loadPageDetails() {
    setLoading(true);
    setError('');
    setPage(null);
    setNotes([]);
    try {
      const cached=(await cacheForBackend<PageData[]>('library'))?.find(page=>page.id===pageId);
      if(cached){
        const remote=(await cacheForBackend<any[]>('notes')||[]).filter(note=>note.page_id===pageId||note.video_url===cached.url_original);
        const merged=new Map(remote.map(note=>[note.id,parseNote(note)]));
        for(const job of await pendingSaves()){
          if(job.kind==='note'&&job.payload.video_url===cached.url_original)merged.set(job.payload.id,{...parseNote(job.payload),pendingSync:true});
          if(job.kind==='remove-note')merged.delete(job.payload.id);
        }
        setPage(cached);setNotes([...merged.values()]);setLoading(false);
      }
      const pageData = await apiClient.get<PageData>(`/api/pages/${pageId}`);
      setPage(pageData);

      // Load notes for this page
      const notesData: any[] = [];
      for (let offset = 0; ; offset += 1000) {
        const batch = await apiClient.get<any[]>(`/api/companion?page_id=${pageId}&limit=1000&offset=${offset}`);
        if (!Array.isArray(batch)) throw new Error('Invalid note response');
        notesData.push(...batch);
        if (batch.length < 1000) break;
      }
      if (Array.isArray(notesData)) {
        const jobs=await pendingSaves();
        const merged=new Map(notesData.map(n=>[n.id,parseNote(n)]));
        jobs.filter(job=>job.kind==='note'&&job.payload.video_url===pageData.url_original).forEach(job=>merged.set(job.payload.id,{...parseNote(job.payload),pendingSync:true}));
        jobs.filter(job=>job.kind==='remove-note').forEach(job=>merged.delete(job.payload.id));
        const parsedNotes=[...merged.values()].sort((a,b)=>b.createdAt-a.createdAt);
        setNotes(parsedNotes);
      }

      // Initialize assistant greeting
      setChatMessages([
        {
          id: 'welcome',
          sender: 'assistant',
          text: `Ask about **${pageData.title || 'this resource'}**. I can use its title, topics, description and your saved notes.`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } catch (err) {
      setError('Could not load tab details. Check the backend connection and try again.');
      console.error('Failed to load page detail:', err);
    } finally {
      setLoading(false);
    }
  }

  const attachNoteFiles = (files: File[]) => {
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setAttachments(prev => [
            ...prev,
            {
              name: file.name,
              mime: file.type || 'application/octet-stream',
              data: reader.result as string,
              size: file.size
            }
          ]);
        }
      };
      reader.readAsDataURL(file);
    });

  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    attachNoteFiles(Array.from(files));

    if (fileInputRef.current) fileInputRef.current.value = '';
    setShowAttachMenu(false);
  };

  const handleNotePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length) attachNoteFiles(imageFiles);
    // Browser text paste remains available; no clipboard permission is needed.
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleAddComment = async () => {
    if(noteSaveLock.current)return;
    const text = commentText.trim();
    if (!text && attachments.length === 0) return;
    if (!page) return;

    noteSaveLock.current=true;setSavingNote(true);
    const submittedAttachments=[...attachments];
    const now = Date.now();
    const noteId = `comp_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const finalComment = text || (attachments.length > 0 ? '📎 Attached file/screenshot' : 'Saved note');

    const newNoteObj: CompanionNote = {
      id: noteId,
      pageId: page.id,
      videoUrl: page.url_original,
      timestampedUrl: page.url_original,
      videoTitle: page.title || 'Note',
      timestampSeconds: 0,
      timestampFormatted: '00:00',
      comment: finalComment,
      thumbnailUrl: page.favicon_url,
      attachments: attachments.length > 0 ? [...attachments] : undefined,
      createdAt: now
    };

    try {
      await saveOnDevice('note', {
        id: newNoteObj.id,
        created_at:new Date(now).toISOString(),
        video_url: newNoteObj.videoUrl,
        timestamped_url: newNoteObj.timestampedUrl,
        video_title: newNoteObj.videoTitle,
        timestamp_seconds: newNoteObj.timestampSeconds,
        timestamp_formatted: newNoteObj.timestampFormatted,
        comment: newNoteObj.comment,
        thumbnail_url: newNoteObj.thumbnailUrl,
        attachments: submittedAttachments.length > 0 ? JSON.stringify(submittedAttachments) : null,
      });

      setNotes(prev => [{...newNoteObj,pendingSync:true}, ...prev]);
      setCommentText(current=>current.trim()===text?'':current);
      setAttachments(current=>current.filter(attachment=>!submittedAttachments.includes(attachment)));
    } catch (err) {
      setError('Your note could not be saved. Your draft is still here; please try again.');
    } finally {
      noteSaveLock.current=false;setSavingNote(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await saveOnDevice('remove-note',{id:noteId});
      setNotes(prev => prev.filter(n => n.id !== noteId));
      onRefresh?.();
    } catch (err) {
      setError('Could not delete this note. Please try again.');
    }
  };

  const handleToggleImportant = async () => {
    if (!page?.id) return;
    const newVal = !page.is_important;
    setPage(prev => prev ? { ...prev, is_important: newVal } : prev);
    try {
      await apiClient.put(`/api/pages/${page.id}`, { is_important: newVal });
      onRefresh?.();
    } catch {
      setPage(prev => prev ? { ...prev, is_important: !newVal } : prev);
      setError('Could not update the important flag. Please try again.');
    }
  };

  const handleToggleUrgent = async () => {
    if (!page?.id) return;
    const newVal = !page.is_urgent;
    setPage(prev => prev ? { ...prev, is_urgent: newVal } : prev);
    try {
      await apiClient.put(`/api/pages/${page.id}`, { is_urgent: newVal });
      onRefresh?.();
    } catch {
      setPage(prev => prev ? { ...prev, is_urgent: !newVal } : prev);
      setError('Could not update the urgent flag. Please try again.');
    }
  };

  const handleSendAssistantMessage = async (customPrompt?: string) => {
    const question = (customPrompt || chatInput).trim();
    if (!question || askingAssistant || !page?.id) return;

    const userMsg: ChatMessage = {
      id: `usr_${Date.now()}`,
      sender: 'user',
      text: question,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setChatMessages(prev => [...prev, userMsg]);
    if (!customPrompt) setChatInput('');
    setAskingAssistant(true);

    try {
      const res = await apiClient.post<any>('/api/brain/page-chat', {
        page_id: page.id,
        message: question
      });

      const botMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        sender: 'assistant',
        text: res.answer || "I've reviewed this tab and provided the findings above.",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, botMsg]);
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        sender: 'assistant',
        text: 'Could not reach the assistant. Check the backend connection in Settings and try again.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, errMsg]);
    } finally {
      setAskingAssistant(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>Loading tab details & notes...</p>
      </div>
    );
  }

  if (!page) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3>{error || 'Tab not found'}</h3>
        <button className="btn-secondary" onClick={onBack} style={{ marginTop: 12 }}>
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  const youtubeId = extractYoutubeId(page.url_original);
  const heroThumb = youtubeId
    ? `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg`
    : (page.og_image_data || page.favicon_url || null);

  return (
    <div className="tab-detail-container" style={{ padding: '8px 0 100px', maxWidth: 1000, margin: '0 auto', position: 'relative' }}>
      {error && <div className="connection-notice" role="alert">{error}</div>}
      {/* Top Navigation */}
      <div className="detail-toolbar">
        <button
          onClick={onBack}
          style={{
            background: 'rgba(255, 255, 255, 0.06)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            color: 'var(--text-primary)',
            padding: '6px 14px',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          <span>←</span> Back to Dashboard
        </button>

        <div className="detail-actions">
          <CompletionButton page={page} onUpdated={updated => { setPage(updated); onRefresh?.(); }} />
          <button
            onClick={handleToggleImportant}
            style={{
              background: page.is_important ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${page.is_important ? '#f59e0b' : 'rgba(255, 255, 255, 0.12)'}`,
              color: page.is_important ? '#f59e0b' : 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600
            }}
          >
            ★ Important
          </button>
          <button
            onClick={handleToggleUrgent}
            style={{
              background: page.is_urgent ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${page.is_urgent ? '#ef4444' : 'rgba(255, 255, 255, 0.12)'}`,
              color: page.is_urgent ? '#ef4444' : 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600
            }}
          >
            🔥 Urgent
          </button>
          <a
            href={page.url_original}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: 'linear-gradient(135deg, #7c5cff 0%, #6366f1 100%)',
              color: '#fff',
              padding: '6px 14px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            Open Tab ↗
          </a>
        </div>
      </div>

      {/* Hero Banner Section */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border, rgba(255, 255, 255, 0.1))',
          borderRadius: 14,
          overflow: 'hidden',
          marginBottom: 24,
          boxShadow: '0 8px 30px rgba(0,0,0,0.4)'
        }}
      >
        {heroThumb && (
          <div style={{ position: 'relative', width: '100%', height: 260, background: '#0a0a0c', overflow: 'hidden' }}>
            <img
              src={heroThumb}
              alt={page.title || ''}
              style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.85 }}
            />
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 120,
              background: 'linear-gradient(180deg, transparent 0%, rgba(20, 20, 25, 0.95) 100%)'
            }} />
          </div>
        )}

        <div style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{
              background: 'rgba(124, 92, 255, 0.2)',
              border: '1px solid rgba(124, 92, 255, 0.4)',
              color: '#a78bfa',
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 6
            }}>
              {page.domain || 'web'}
            </span>
            {(page.display_topic || page.topic) && (
              <span style={{
                background: 'rgba(16, 185, 129, 0.2)',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                color: '#34d399',
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 6
              }}>
                #{page.display_topic || page.topic}
              </span>
            )}
            {page.category && (
              <span style={{
                background: 'rgba(244, 63, 94, 0.15)',
                border: '1px solid rgba(244, 63, 94, 0.35)',
                color: '#fb7185',
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 6
              }}>
                📁 {page.category}
              </span>
            )}
          </div>

          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 12px 0', lineHeight: 1.3 }}>
            {page.title || 'Untitled Tab'}
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 12, marginBottom: 16 }}>
            <span style={{ wordBreak: 'break-all' }}>{page.url_original}</span>
          </div>

          {page.description && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
              {page.description}
            </p>
          )}
        </div>
      </div>

      {/* Comments & Notes Section */}
      <div style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📝 Saved Notes & Comments</span>
            <span style={{
              background: 'var(--surface-hover)',
              color: 'var(--text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 12
            }}>
              {notes.length}
            </span>
          </h2>
        </div>

        {notes.length === 0 ? (
          <div style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px dashed rgba(255, 255, 255, 0.12)',
            borderRadius: 12,
            padding: 36,
            textAlign: 'center',
            color: 'var(--text-secondary)'
          }}>
            <p style={{ fontSize: 14, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>No notes or comments yet for this tab.</p>
            <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)' }}>Add a takeaway, paste a snip, or attach a file below.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {notes.map(note => (
              <div
                key={note.id}
                data-note-id={note.id}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
                  borderRadius: 12,
                  padding: 16,
                  transition: 'border-color 0.15s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {note.timestampSeconds > 0 && (
                      <a
                        href={note.timestampedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          background: 'rgba(239, 68, 68, 0.15)',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          color: '#f87171',
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 6,
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        <span>▶</span> {note.timestampFormatted}
                      </a>
                    )}
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                      {new Date(note.createdAt).toLocaleDateString()} at {new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <button
                    onClick={() => handleDeleteNote(note.id)}
                    title="Delete Note"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: 14,
                      padding: '2px 6px'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  >
                    ✕
                  </button>
                </div>

                <p style={{ color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.5, margin: '0 0 10px 0', whiteSpace: 'pre-wrap' }}>
                  {note.pendingSync && <small className="pending-label">Saved on device · Pending upload</small>}{note.comment}
                </p>

                {/* Render Attachments */}
                {note.attachments && note.attachments.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                    {note.attachments.map((att, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        {att.mime.startsWith('image/') ? (
                          <a href={att.data} target="_blank" rel="noopener noreferrer" title={`Click to view ${att.name}`}>
                            <img
                              src={att.data}
                              alt={att.name}
                              style={{
                                width: 140,
                                height: 90,
                                objectFit: 'cover',
                                borderRadius: 8,
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                                display: 'block'
                              }}
                            />
                          </a>
                        ) : (
                          <a
                            href={att.data}
                            download={att.name}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              background: 'var(--surface-hover)',
                              border: '1px solid rgba(255, 255, 255, 0.12)',
                              color: '#38bdf8',
                              padding: '6px 12px',
                              borderRadius: 8,
                              fontSize: 12,
                              textDecoration: 'none'
                            }}
                          >
                            <span>📄</span>
                            <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {att.name}
                            </span>
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Docked Comment Bar at Bottom */}
      <div
        style={{
          position: 'relative',
          background: 'var(--surface)',
          border: '1px solid rgba(124, 92, 255, 0.3)',
          borderRadius: 14,
          padding: 12,
          boxShadow: '0 10px 35px rgba(0, 0, 0, 0.7)',
          zIndex: 50
        }}
      >
        {/* Attachment chips preview */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {attachments.map((att, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(124, 92, 255, 0.18)',
                  border: '1px solid rgba(124, 92, 255, 0.4)',
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: 11,
                  color: 'var(--text-primary)'
                }}
              >
                {att.mime.startsWith('image/') ? (
                  <img src={att.data} style={{ width: 16, height: 16, borderRadius: 3, objectFit: 'cover' }} alt="" />
                ) : (
                  <span>📄</span>
                )}
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {att.name}
                </span>
                <button
                  onClick={() => handleRemoveAttachment(idx)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Plus Button */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowAttachMenu(!showAttachMenu)}
              title="Attach files or paste copied images into your note"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'var(--surface-hover)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#fff',
                fontSize: 20,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              +
            </button>

            {showAttachMenu && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  left: 0,
                  width: 200,
                  background: 'var(--surface)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  borderRadius: 10,
                  padding: 6,
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4
                }}
              >
                <button
                  onClick={() => {
                    fileInputRef.current?.click();
                    setShowAttachMenu(false);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-primary)',
                    padding: '8px 10px',
                    textAlign: 'left',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(124, 92, 255, 0.2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span>📎</span> Upload Doc / Picture
                </button>
              </div>
            )}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/*,.pdf,.doc,.docx,.txt"
              multiple
              onChange={handleFileUpload}
            />
          </div>

          <input
            type="text"
            placeholder="Add a note or paste an image… (Enter to save)"
            aria-label="Add a note or paste an image"
            onPaste={handleNotePaste}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddComment();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--surface-hover)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 8,
              padding: '8px 14px',
              color: 'var(--text-primary)',
              fontSize: 13,
              outline: 'none'
            }}
          />

          <button
            onClick={handleAddComment}
            disabled={savingNote || (!commentText.trim() && attachments.length === 0)}
            style={{
              background: 'linear-gradient(135deg, #7c5cff 0%, #6366f1 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: savingNote ? 'default' : 'pointer',
              opacity: (!commentText.trim() && attachments.length === 0) ? 0.5 : 1
            }}
          >
            {savingNote ? 'Saving...' : 'Add Note'}
          </button>
        </div>
      </div>

      {/* Floating In-Context AI Assistant Bubble (Bottom Right) */}
      <div className="detail-assistant">
        {!isAssistantOpen ? (
          <button
            onClick={() => setIsAssistantOpen(true)}
            title="Chat directly about this tab"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'linear-gradient(135deg, #7c5cff 0%, #a855f7 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: 30,
              padding: '10px 18px',
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(124, 92, 255, 0.5), 0 0 12px rgba(168, 85, 247, 0.4)',
              fontWeight: 600,
              fontSize: 13,
              transition: 'transform 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            <span style={{ fontSize: 16 }}>✦</span>
            <span>Ask Karl about this tab</span>
          </button>
        ) : (
          <div
            style={{
              width: 'min(380px, calc(100vw - 96px))',
              height: 'min(520px, calc(100dvh - 48px))',
              background: 'var(--surface)',
              border: '1px solid rgba(124, 92, 255, 0.4)',
              borderRadius: 16,
              boxShadow: '0 12px 40px rgba(0, 0, 0, 0.8), 0 0 15px rgba(124, 92, 255, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              animation: 'slideUp 0.2s ease-out'
            }}
          >
            {/* Header */}
            <div
              style={{
                background: 'linear-gradient(90deg, #1f1b2e 0%, #171720 100%)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                <span style={{ color: '#a78bfa', fontSize: 16 }}>✦</span>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>Tab AI Assistant</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                    {page.title}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setIsAssistantOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  fontSize: 16,
                  cursor: 'pointer',
                  padding: 4
                }}
              >
                ✕
              </button>
            </div>

            {/* Quick Action Chips */}
            <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', overflowX: 'auto', background: 'var(--bg)' }}>
              <button
                onClick={() => handleSendAssistantMessage('Please give me a concise 3-bullet summary of this tab.')}
                style={{
                  background: 'rgba(124, 92, 255, 0.15)',
                  border: '1px solid rgba(124, 92, 255, 0.3)',
                  color: '#c4b5fd',
                  borderRadius: 12,
                  padding: '3px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                📝 Summarize
              </button>
              <button
                onClick={() => handleSendAssistantMessage('What are the key technical takeaways and concepts from this page?')}
                style={{
                  background: 'rgba(16, 185, 129, 0.15)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  color: '#6ee7b7',
                  borderRadius: 12,
                  padding: '3px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                💡 Key takeaways
              </button>
              <button
                onClick={() => handleSendAssistantMessage('Based on my saved notes and this page, what should I remember or study next?')}
                style={{
                  background: 'rgba(244, 63, 94, 0.15)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  color: '#fda4af',
                  borderRadius: 12,
                  padding: '3px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                💭 Review notes
              </button>
            </div>

            {/* Chat Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {chatMessages.map(msg => (
                <div
                  key={msg.id}
                  style={{
                    alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    background: msg.sender === 'user' ? '#7c5cff' : 'var(--surface-hover)',
                    color: '#fff',
                    borderRadius: 12,
                    padding: '8px 12px',
                    fontSize: 12,
                    lineHeight: 1.5,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  <div>{msg.text}</div>
                  <div style={{ fontSize: 9, opacity: 0.6, marginTop: 4, textAlign: msg.sender === 'user' ? 'right' : 'left' }}>
                    {msg.time}
                  </div>
                </div>
              ))}
              {askingAssistant && (
                <div style={{ alignSelf: 'flex-start', background: 'var(--surface-hover)', color: 'var(--text-secondary)', borderRadius: 12, padding: '8px 12px', fontSize: 11 }}>
                  <span>Analyzing this tab... ✦</span>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Chat Input */}
            <div style={{ padding: 10, borderTop: '1px solid rgba(255, 255, 255, 0.08)', background: 'var(--bg)', display: 'flex', gap: 6 }}>
              <input
                type="text"
                placeholder="Ask about this tab..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSendAssistantMessage();
                  }
                }}
                disabled={askingAssistant}
                style={{
                  flex: 1,
                  background: 'var(--surface)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  color: '#fff',
                  fontSize: 12,
                  outline: 'none'
                }}
              />
              <button
                onClick={() => handleSendAssistantMessage()}
                disabled={askingAssistant || !chatInput.trim()}
                style={{
                  background: '#7c5cff',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: askingAssistant ? 'default' : 'pointer',
                  opacity: !chatInput.trim() ? 0.5 : 1
                }}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

