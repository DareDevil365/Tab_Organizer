import React, { useState, useRef, useEffect } from 'react';
import { apiClient } from '../../lib/api-client';
import { MarkdownContent } from '../components/MarkdownContent';

interface SourceItem {
  id: number;
  title: string;
  url: string;
  domain?: string;
  topic?: string;
  similarity_score?: number;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  sources?: SourceItem[];
}

export const Brain: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: "👋 **Hello! I am your Personal Knowledge Brain.**\n\nAsk me anything about your saved tabs, research notes, or topics, or click one of the suggested prompts below to explore your knowledge base."
    }
  ]);
  const [inputQuery, setInputQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [planTopic, setPlanTopic] = useState<string>('');
  const [showPlanModal, setShowPlanModal] = useState<boolean>(false);
  const [highlightedSource, setHighlightedSource] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const quickPrompts = [
    "🎓 What all do I have to study?",
    "🤖 What AI & LLM resources do I have?",
    "🏎️ Summarize my automotive tabs",
    "🗺️ Create a study roadmap for Deep Learning"
  ];

  async function executeQuery(question: string) {
    if (!question.trim() || loading) return;

    const userMsg: ChatMessage = { id: String(Date.now()), sender: 'user', text: question };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await apiClient.post<{ answer: string; sources: SourceItem[] }>('/api/brain/ask', {
        question
      });

      const aiMsg: ChatMessage = {
        id: String(Date.now() + 1),
        sender: 'assistant',
        text: res.answer,
        sources: res.sources
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          id: String(Date.now() + 1),
          sender: 'assistant',
          text: "⚠️ **Failed to query the Brain assistant.**\n\nPlease ensure the backend server is running at `http://127.0.0.1:8742` and your Gemini API keys are active in `.env`."
        }
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!inputQuery.trim()) return;
    const query = inputQuery.trim();
    setInputQuery('');
    executeQuery(query);
  }

  async function handleGeneratePlan() {
    if (!planTopic.trim()) return;
    const topic = planTopic.trim();
    setShowPlanModal(false);
    setPlanTopic('');

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      sender: 'user',
      text: `🗺️ Generate a structured learning plan for: "${topic}"`
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await apiClient.post<{ plan: string; resources_used: SourceItem[] }>('/api/brain/plan', {
        topic
      });

      const aiMsg: ChatMessage = {
        id: String(Date.now() + 1),
        sender: 'assistant',
        text: res.plan,
        sources: res.resources_used
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          id: String(Date.now() + 1),
          sender: 'assistant',
          text: "⚠️ **Failed to generate learning plan.** Please ensure the backend AI provider is active."
        }
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
  }

  function handleCitationClick(msgId: string, citeIndex: number) {
    const cardId = `source-${msgId}-${citeIndex}`;
    setHighlightedSource(cardId);
    const el = document.getElementById(cardId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setTimeout(() => setHighlightedSource(null), 3000);
  }

  return (
    <div className="brain-container">
      <div className="brain-header">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>
            🧠 Personal Knowledge Brain
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
            Semantic RAG intelligence across your saved tabs, notes, and lecture materials
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setShowPlanModal(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13 }}
        >
          <span>🗺️</span>
          <span>Generate Learning Plan</span>
        </button>
      </div>

      {/* Quick Prompt Suggestions */}
      <div className="prompt-suggestions">
        {quickPrompts.map((prompt, i) => (
          <button
            key={i}
            className="suggestion-pill"
            onClick={() => executeQuery(prompt)}
            disabled={loading}
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Plan Modal */}
      {showPlanModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999
        }}>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            padding: 24,
            width: 440,
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
          }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 18, fontWeight: 700 }}>🗺️ Create Structured Learning Plan</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              The brain will synthesize a curriculum connecting your saved tabs and lecture videos into an organized study roadmap.
            </p>
            <input
              type="text"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text-primary)',
                fontSize: 14,
                marginBottom: 16,
                outline: 'none'
              }}
              placeholder="e.g. Artificial Intelligence, Next.js, Financial Modeling"
              value={planTopic}
              onChange={(e) => setPlanTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleGeneratePlan(); }}
              autoFocus
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => setShowPlanModal(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleGeneratePlan}
                disabled={!planTopic.trim()}
                style={{ padding: '8px 18px', fontSize: 13 }}
              >
                Generate Syllabus
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Messages */}
      <div className="chat-history">
        {messages.map(msg => (
          <div key={msg.id} className={`chat-bubble ${msg.sender}`}>
            {msg.sender === 'assistant' && (
              <div className="assistant-header">
                <div className="assistant-title">
                  <span>✦</span>
                  <span>Karl X Brain</span>
                </div>
                <button
                  className="action-icon-btn"
                  onClick={() => handleCopy(msg.id, msg.text)}
                  title="Copy response"
                >
                  {copiedId === msg.id ? '✓ Copied' : '📋 Copy'}
                </button>
              </div>
            )}

            {/* Formatted Markdown Content */}
            <MarkdownContent
              content={msg.text}
              sources={msg.sources}
              onCitationClick={(idx) => handleCitationClick(msg.id, idx)}
            />

            {/* Distinct Source Cards Grid */}
            {msg.sources && msg.sources.length > 0 && (
              <div className="sources-section">
                <div className="sources-header">
                  <span>📚</span>
                  <span>Referenced Library Sources ({msg.sources.length})</span>
                </div>
                <div className="sources-grid">
                  {msg.sources.map((s, sIdx) => {
                    const cardId = `source-${msg.id}-${sIdx + 1}`;
                    const isHighlighted = highlightedSource === cardId;
                    return (
                      <a
                        key={s.id || sIdx}
                        id={cardId}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`source-card ${isHighlighted ? 'highlighted' : ''}`}
                        title={`Open ${s.title || s.url}`}
                      >
                        <div className="source-badge">
                          {sIdx + 1}
                        </div>
                        <div className="source-info">
                          <div className="source-title">{s.title || s.domain || s.url}</div>
                          <div className="source-meta">
                            <span>{s.domain || (s.url ? (() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '')}</span>
                            {s.topic && (
                              <span className="topic-tag">#{s.topic}</span>
                            )}
                            {s.similarity_score !== undefined && (
                              <span>· {Math.round(s.similarity_score * 100)}% match</span>
                            )}
                          </div>
                        </div>
                        <span className="source-arrow">↗</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="chat-bubble assistant">
            <div className="assistant-header">
              <div className="assistant-title">
                <span>✦</span>
                <span>Karl X Brain</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: '10px 0' }}>
              <span style={{ animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>🧠</span>
              <span>Thinking and searching library embeddings with Gemini...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Chat Input Bar */}
      <form onSubmit={handleSend} className="chat-input-row">
        <input
          type="text"
          className="chat-input"
          placeholder="Ask a question about your saved tabs (e.g. 'What all do I have to study?')..."
          value={inputQuery}
          onChange={(e) => setInputQuery(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          className="btn-chat-send"
          disabled={loading || !inputQuery.trim()}
        >
          <span>Send</span>
          <span>→</span>
        </button>
      </form>
    </div>
  );
};
