import { BackendStatus } from '../types';

class StorageManager {
  async get<T>(key: string): Promise<T | null> {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] as T : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }

  async getBackendStatus(): Promise<BackendStatus> {
    const status = await this.get<BackendStatus>('backend_status');
    return status || 'checking';
  }

  async setBackendStatus(status: BackendStatus): Promise<void> {
    await this.set('backend_status', status);
  }
}

export const storage = new StorageManager();
