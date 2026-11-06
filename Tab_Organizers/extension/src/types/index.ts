export interface TabInfo {
  id?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  groupId: number;
  windowId: number;
  active: boolean;
  pinned: boolean;
}

export interface TabGroupInfo {
  id: number;
  title?: string;
  color: string;
  collapsed: boolean;
  windowId: number;
}

export interface PageData {
  pendingSync?:boolean;
  display_topic?: string | null;
  subject_topics?: string[];
  search_score?: number;
  completed_at?: string | null;
  completion_kind?: 'watched' | 'read';
  note_count?: number;
  id?: number;
  url_original: string;
  url_normalized: string;
  title: string;
  description: string;
  favicon_url: string;
  og_image_data?: string;
  og_image_url?: string;
  domain: string;
  category?: string;
  topic?: string;
  content_summary?: string;
  full_text?: string;
  tags?: string;
  is_important?: boolean;
  is_urgent?: boolean;
  created_at?: string;
}

export interface BackendHealth {
  status: string;
  version: string;
}

export interface ExportRequest {
  pages: PageData[];
  group_name?: string;
}

export type BackendStatus = 'connected' | 'disconnected' | 'checking';

export interface NoteAttachment {
  name: string;
  mime: string;
  data: string; // base64 / data URL
  size?: number;
}

export interface CompanionNote {
  outboxManaged?:boolean;
  id: string;
  pendingSync?: boolean;
  tabId?: number;
  pageId?: number;
  videoUrl: string;
  timestampedUrl: string;
  videoTitle: string;
  timestampSeconds: number;
  timestampFormatted: string;
  comment: string;
  thumbnailUrl?: string;
  attachments?: NoteAttachment[];
  createdAt: number;
}
