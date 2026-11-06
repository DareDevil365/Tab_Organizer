import { useState } from 'react';
import { siteIconSources } from '../../lib/site-icon';

/** Prefer the browser's favicon, then the website itself, with a neutral fallback. */
export function SiteIcon({ url, favicon }: { url: string; favicon?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const sources = siteIconSources(url, favicon);
  const source = sources.find(value => !failed.includes(value)) || sources[sources.length - 1];
  return <img alt="" src={source} referrerPolicy="no-referrer" onError={() => {
    if (source !== sources[sources.length - 1]) setFailed(values => [...values, source]);
  }} />;
}
