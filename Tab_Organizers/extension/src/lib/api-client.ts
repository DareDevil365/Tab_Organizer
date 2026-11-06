import { BackendHealth } from '../types';
import { getBackendConnection } from './backend-connection';

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(`API error: ${status} ${detail}`);
    this.name='ApiError';
  }
}

class ApiClient {
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    try {
      const connection=await getBackendConnection();
      const response = await fetch(`${connection.url}${endpoint}`, {
        ...options,
        signal:options?.signal||AbortSignal.timeout(endpoint.includes('/brain/')||endpoint==='/api/graph'||endpoint==='/api/search'?120000:15000),
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
          ...(connection.key?{Authorization:`Bearer ${connection.key}`} : {}),
        },
      });

      if (!response.ok) {
        const body=await response.json().catch(()=>null);
        throw new ApiError(response.status, typeof body?.detail==='string'?body.detail:response.statusText);
      }

      if (response.status === 204) return (response.headers.get('X-Recycle-Id')?{recycle_id:response.headers.get('X-Recycle-Id')}:undefined) as T;
      return await response.json() as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      console.error(`Error in API request to ${endpoint}:`, error);
      throw error;
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, data: any, signal?: AbortSignal): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      signal,
    });
  }

  async put<T>(endpoint: string, data: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  async healthCheck(): Promise<BackendHealth> {
    try {
      const health=await this.get<BackendHealth>('/health');
      const connection=await getBackendConnection();
      if(connection.key||connection.url!=='http://127.0.0.1:8742')await this.get('/auth/session');
      return health;
    } catch (error) {
      return { status: 'error', version: 'unknown' };
    }
  }
}

export const apiClient = new ApiClient();
