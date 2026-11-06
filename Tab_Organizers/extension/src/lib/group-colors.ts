/**
 * Tab Group Color Management
 * 
 * Provides an 8-color high-contrast rotation palette for Chrome Tab Groups,
 * ensuring each new group receives a distinct, visually contrasting color
 * label that exhausts all vibrant colors before repeating.
 */

// Chrome strictly supports these 9 tab group colors:
export type ChromeGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

/**
 * 8 vibrant colors ordered for maximum contrast between adjacent items.
 * Consecutive pairs are complementary or strong warm-cool contrasts:
 * Blue -> Orange -> Green -> Red -> Cyan -> Purple -> Yellow -> Pink (-> Blue)
 */
export const CONTRASTING_GROUP_COLORS: ChromeGroupColor[] = [
  'blue',    // 1. Cool deep blue (#8ab4f8)
  'orange',  // 2. Warm bright orange (#fcad70) - Complementary to blue
  'green',   // 3. Fresh emerald green (#81c995) - Sharp contrast with orange
  'red',     // 4. Vibrant warm red (#f28b82) - Complementary to green
  'cyan',    // 5. Electric bright cyan (#78d9ec) - Complementary to red
  'purple',  // 6. Deep royal purple (#c58af9) - High contrast with cyan
  'yellow',  // 7. Sunny bright yellow (#fdd663) - Complementary to purple
  'pink'     // 8. Vivid magenta/pink (#ff8bcb) - High contrast with yellow & blue
];

export const VALID_GROUP_COLORS: ChromeGroupColor[] = [
  ...CONTRASTING_GROUP_COLORS,
  'grey'
];

export const CHROME_COLOR_HEX_MAP: Record<ChromeGroupColor, string> = {
  blue: '#8ab4f8',
  orange: '#fcad70',
  green: '#81c995',
  red: '#f28b82',
  cyan: '#78d9ec',
  purple: '#c58af9',
  yellow: '#fdd663',
  pink: '#ff8bcb',
  grey: '#dadce0'
};

export function getChromeColorHex(color: string): string {
  return CHROME_COLOR_HEX_MAP[color as ChromeGroupColor] || CHROME_COLOR_HEX_MAP.blue;
}

/**
 * Gets the next recommended contrasting group color by:
 * 1. Inspecting active Chrome tab groups to avoid colors already in use.
 * 2. Rotating through the 8-color contrasting palette based on stored cycle index.
 * 3. Exhausting all 8 colors before allowing repeats.
 */
export async function getNextContrastingGroupColor(): Promise<ChromeGroupColor> {
  try {
    const activeColors = new Set<string>();

    // 1. Query active tab groups in Chrome
    if (typeof chrome !== 'undefined' && chrome.tabGroups?.query) {
      try {
        const groups = await chrome.tabGroups.query({});
        groups.forEach(g => {
          if (g.color) activeColors.add(g.color);
        });
      } catch (err) {
        console.debug('Failed to query tabGroups for active colors:', err);
      }
    }

    // 2. Fetch stored cycle index
    let cycleIndex = 0;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(['group_color_cycle_index']);
      if (typeof data.group_color_cycle_index === 'number') {
        cycleIndex = data.group_color_cycle_index;
      }
    }

    // 3. Search for the first unused color from the palette starting at cycleIndex
    for (let i = 0; i < CONTRASTING_GROUP_COLORS.length; i++) {
      const candidateIndex = (cycleIndex + i) % CONTRASTING_GROUP_COLORS.length;
      const candidate = CONTRASTING_GROUP_COLORS[candidateIndex];
      if (!activeColors.has(candidate)) {
        return candidate;
      }
    }

    // 4. If all 8 colors are already in use, pick palette[cycleIndex % length]
    return CONTRASTING_GROUP_COLORS[cycleIndex % CONTRASTING_GROUP_COLORS.length];
  } catch (err) {
    console.debug('Error in getNextContrastingGroupColor:', err);
    return CONTRASTING_GROUP_COLORS[0];
  }
}

/**
 * Updates the stored cycle index when a group color is confirmed/used.
 * Advances the index past the used color so the next group uses a contrasting color.
 */
export async function markGroupColorUsed(usedColor: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const colorIndex = CONTRASTING_GROUP_COLORS.indexOf(usedColor as ChromeGroupColor);
    let nextIndex: number;
    if (colorIndex !== -1) {
      nextIndex = (colorIndex + 1) % CONTRASTING_GROUP_COLORS.length;
    } else {
      const data = await chrome.storage.local.get(['group_color_cycle_index']);
      const current = typeof data.group_color_cycle_index === 'number' ? data.group_color_cycle_index : 0;
      nextIndex = (current + 1) % CONTRASTING_GROUP_COLORS.length;
    }
    await chrome.storage.local.set({ group_color_cycle_index: nextIndex });
  } catch (err) {
    console.debug('Error saving group_color_cycle_index:', err);
  }
}
