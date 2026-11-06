/** Curated notebook inks; topic identity stays consistent between resources. */
const INKS = [
  { name: 'jade', from: '#286b5c', to: '#153f37', dot: '#90c7b3' },
  { name: 'petrol', from: '#32677b', to: '#1b3748', dot: '#91bdcf' },
  { name: 'oxblood', from: '#874b4a', to: '#4c282e', dot: '#d2a2a0' },
  { name: 'ochre', from: '#7d6839', to: '#4b4027', dot: '#d8c18a' },
  { name: 'cobalt', from: '#456590', to: '#263a5a', dot: '#a3bbdd' },
  { name: 'cognac', from: '#8b5838', to: '#503624', dot: '#dcb393' },
] as const;

export function coverInk(subject: string) {
  const value = subject.toLowerCase();
  if (/artificial|neural|machine|learning|\bai\b/.test(value)) return INKS[0];
  if (/program|develop|react|code|engineer/.test(value)) return INKS[1];
  if (/entertain|video|film|music|movie/.test(value)) return INKS[2];
  if (/design|typograph|creative|art\b/.test(value)) return INKS[5];
  if (/opportun|hackathon|project|build/.test(value)) return INKS[3];
  if (/academic|science|hardware|tech/.test(value)) return INKS[4];
  let hash = 0;
  for (const character of value) hash = Math.imul(hash, 31) + character.charCodeAt(0) | 0;
  return INKS[(hash >>> 0) % INKS.length];
}
