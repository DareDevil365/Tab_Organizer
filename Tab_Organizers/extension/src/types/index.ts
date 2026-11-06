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
  url_original: string;
  url_normalized: string;
  title: string;
  description: string;
  favicon_url: string;
  og_image_data?: string;
  domain: string;
  category?: string;
  topic?: string;
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
