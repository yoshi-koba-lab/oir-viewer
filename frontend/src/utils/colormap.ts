export interface LUT {
  name: string;
  color: [number, number, number]; // RGB 0-255 for single-color LUTs
}

export const LUTS: LUT[] = [
  // Greens
  { name: 'Green', color: [0, 255, 0] },
  { name: 'Lime', color: [128, 255, 0] },
  { name: 'Dark Green', color: [0, 180, 0] },
  // Blues
  { name: 'Blue', color: [0, 100, 255] },
  { name: 'Deep Blue', color: [0, 50, 200] },
  { name: 'Sky Blue', color: [80, 180, 255] },
  // Reds / Warm
  { name: 'Red', color: [255, 0, 0] },
  { name: 'Dark Red', color: [200, 0, 0] },
  { name: 'Orange', color: [255, 165, 0] },
  { name: 'Yellow', color: [255, 255, 0] },
  // Purple / Pink
  { name: 'Magenta', color: [255, 0, 255] },
  { name: 'Purple', color: [160, 32, 240] },
  { name: 'Hot Pink', color: [255, 105, 180] },
  // Cyan / Teal
  { name: 'Cyan', color: [0, 255, 255] },
  { name: 'Teal', color: [0, 200, 180] },
  // Neutrals
  { name: 'White', color: [255, 255, 255] },
  { name: 'Gray', color: [180, 180, 180] },
];

/** Default LUT assignment for channels */
export const DEFAULT_CHANNEL_LUTS = [
  LUTS[3],  // Ch0 DAPI → Blue
  LUTS[0],  // Ch1 GFP → Green
  LUTS[6],  // Ch2 RFP → Red
  LUTS[13], // Ch3 Cy5 → Cyan
  LUTS[15], // Ch4 → White
  LUTS[9],  // Ch5 → Yellow
  LUTS[8],  // Ch6 → Orange
  LUTS[15], // Ch7 → White
];

export function getLutColor(channelIndex: number): [number, number, number] {
  return DEFAULT_CHANNEL_LUTS[channelIndex % DEFAULT_CHANNEL_LUTS.length].color;
}

/** LUT color for transmitted light channels (DIC, brightfield, etc.) */
export const TRANSMITTED_COLOR: [number, number, number] = [180, 180, 180];
