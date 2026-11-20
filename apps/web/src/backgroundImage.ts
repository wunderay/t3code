import "culori/css";
import { clampChroma, converter, formatHex, wcagContrast, wcagLuminance } from "culori/fn";

import {
  createVividThemeColors,
  readableThemeColorOn,
  toCanonicalThemeColor,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from "./themePalette";

export const BACKGROUND_IMAGE_STORAGE_KEY = "t3code:background-image:v1";
// Read by the boot script in index.html, which must not parse the image itself.
export const BACKGROUND_IMAGE_BOOT_STORAGE_KEY = "t3code:background-image-boot:v1";
// localStorage holds about 5 MB per origin and custom themes share it.
const MAX_STORED_IMAGE_LENGTH = 2_000_000;
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1920;
const SAMPLE_EDGE = 64;
const MIN_VEIL_PERMILLE = 500;
// JPEG has no alpha; flattening first makes the palette sample what is shown.
const FLATTEN_COLOR = "#ffffff";
const STORED_IMAGE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** `highlight` and `shadow` are the 95th and 5th luminance percentiles, the colors text must read over. */
export type BackgroundPalette = Readonly<{
  base: string;
  accent: string;
  highlight: string;
  shadow: string;
}>;
export type BackgroundImage = Readonly<{ image: string; palette: BackgroundPalette }>;

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const hex = (r: number, g: number, b: number) =>
  formatHex({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 });

export function extractBackgroundPalette(pixels: Uint8ClampedArray): BackgroundPalette {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const [r, g, b] = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
    total += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count += 1;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }

  const ranked = [...bins.entries()]
    .toSorted(([keyA, a], [keyB, b]) => b.count - a.count || keyA - keyB)
    .map(([, bin]) => {
      const color = hex(bin.r / bin.count, bin.g / bin.count, bin.b / bin.count);
      const { c = 0, h = 0 } = toOklch(color) ?? {};
      return { color, count: bin.count, chroma: c, hue: h };
    });
  const base = ranked[0]!;
  const colorful = (bin: (typeof ranked)[number]) => bin.chroma >= 0.04;
  const hueGap = (bin: (typeof ranked)[number]) =>
    Math.abs(((bin.hue - base.hue + 540) % 360) - 180);
  // A second hue complements the base; without one, the base's own most colorful shade stands in.
  const complements = colorful(base)
    ? ranked.filter((bin) => colorful(bin) && hueGap(bin) >= 30)
    : [];
  // Weighting chroma by the square root of area favors a colorful region over a vivid speck.
  const accent = (complements.length > 0 ? complements : ranked).reduce((best, bin) =>
    bin.chroma * Math.sqrt(bin.count) > best.chroma * Math.sqrt(best.count) ? bin : best,
  );
  // Measured at the single extreme pixel, any photo with a highlight would be veiled to nothing.
  const byLuminance = ranked.toSorted((a, b) => wcagLuminance(a.color) - wcagLuminance(b.color));
  const percentile = (share: number) => {
    let seen = 0;
    return byLuminance.find((bin) => (seen += bin.count) >= share * total)!.color;
  };
  return {
    base: base.color,
    accent: accent.color,
    highlight: percentile(0.95),
    shadow: percentile(0.05),
  };
}

function oklchHex(l: number, c: number, h: number): string {
  return formatHex(clampChroma({ mode: "oklch", l, c, h }, "oklch"));
}

const VEILED_ROLES = ["canvas", "chrome", "toolbar", "sidebar"] as const;
// Text on the veiled roles, at the floors createVividThemeColors gives it on an opaque canvas.
const VEILED_TEXT: ReadonlyArray<
  readonly [ThemeColorRole, ThemeColorRole, number, ReadonlyArray<ThemeColorRole>]
> = [
  ["text", "canvas", 7, ["toolbarForeground", "toolbarControlForeground"]],
  ["textMuted", "canvas", 4.6, ["secondaryLabel", "iconMuted"]],
  ["sidebarForeground", "sidebar", 4.6, []],
  ["sidebarMutedForeground", "sidebar", 4.6, []],
];

/** The 8-bit color the browser paints for `color` at `opacity` over `underlay`. */
function paintedOver(color: string, underlay: string, opacity: number): string {
  const top = toRgb(color)!;
  const bottom = toRgb(underlay)!;
  const mix = (front: number, back: number) => front * opacity + back * (1 - opacity);
  return formatHex({
    mode: "rgb",
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
  });
}

function veiledText(
  colors: ThemeColors,
  underlay: string,
  opacity: number,
): Partial<Record<ThemeColorRole, string>> | null {
  const solved: Partial<Record<ThemeColorRole, string>> = {};
  for (const [foreground, background, minContrast, followers] of VEILED_TEXT) {
    const surface = paintedOver(colors[background], underlay, opacity);
    const color = readableThemeColorOn(colors[foreground], surface, minContrast);
    if (wcagContrast(color, surface) < minContrast) return null;
    for (const role of [foreground, ...followers]) solved[role] = color;
  }
  return solved;
}

/**
 * The image's theme: its base hue as the canvas and its most colorful region as the accent,
 * with the canvas veil as transparent as readable text over `highlight` or `shadow` allows.
 */
export function backgroundImageColors(
  palette: BackgroundPalette,
  appearance: ThemeAppearance,
): ThemeColors {
  const dark = appearance === "dark";
  const base = toOklch(palette.base)!;
  const accent = toOklch(palette.accent)!;
  const canvas = oklchHex(dark ? 0.2 : 0.97, Math.min(base.c, 0.03), base.h ?? 0);
  const accentLightness = Math.min(dark ? 0.8 : 0.6, Math.max(dark ? 0.62 : 0.45, accent.l));
  const colors = createVividThemeColors(
    appearance,
    canvas,
    oklchHex(accentLightness, accent.c, accent.h ?? base.h ?? 0),
  );
  const underlay = dark ? palette.highlight : palette.shadow;
  // Search whole thousandths, so the opacity written is the one measured.
  let low = MIN_VEIL_PERMILLE - 1;
  let high = 1000;
  let text = veiledText(colors, underlay, 1) ?? {};
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const solved = veiledText(colors, underlay, mid / 1000);
    if (solved) {
      high = mid;
      text = solved;
    } else {
      low = mid;
    }
  }
  const veiled: Partial<Record<ThemeColorRole, string>> = {};
  for (const role of VEILED_ROLES) {
    veiled[role] = toCanonicalThemeColor(colors[role].replace(/\)$/, ` / ${high / 1000})`))!;
  }
  return { ...colors, ...text, ...veiled };
}

function isBackgroundImage(value: unknown): value is BackgroundImage {
  if (typeof value !== "object" || value === null) return false;
  const { image, palette } = value as Record<string, unknown>;
  if (typeof image !== "string" || !STORED_IMAGE.test(image)) return false;
  if (typeof palette !== "object" || palette === null) return false;
  const colors = palette as Record<string, unknown>;
  return (["base", "accent", "highlight", "shadow"] as const).every(
    (key) => typeof colors[key] === "string" && /^#[0-9a-f]{6}$/.test(colors[key]),
  );
}

let cached: { value: BackgroundImage | null; blob: Blob | null; url: string | null } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(BACKGROUND_IMAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getBackgroundImage(): BackgroundImage | null {
  if (typeof window === "undefined") return null;
  if (cached) return cached.value;
  const raw = readRaw();
  let value: BackgroundImage | null = null;
  let blob: Blob | null = null;
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (isBackgroundImage(parsed)) {
      blob = dataUrlToBlob(parsed.image);
      value = parsed;
    }
  } catch {}
  cached = { value, blob, url: null };
  return value;
}

export function invalidateBackgroundImage(): void {
  if (cached?.url) URL.revokeObjectURL(cached.url);
  cached = null;
  for (const listener of listeners) listener();
}

/** Another tab changed or cleared the image: its choice is newer than any import still decoding here. */
export function backgroundImageChangedElsewhere(): void {
  importGeneration += 1;
  invalidateBackgroundImage();
}

export function subscribeToBackgroundImage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyBackgroundImageLayer(root: HTMLElement): void {
  getBackgroundImage();
  if (!cached?.blob) {
    delete root.dataset.backgroundImage;
    root.style.removeProperty("--app-background-image");
    return;
  }
  // A short object URL keeps the inherited custom property small.
  cached.url ??= URL.createObjectURL(cached.blob);
  root.dataset.backgroundImage = "";
  root.style.setProperty("--app-background-image", `url("${cached.url}")`);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data = ""] = dataUrl.split(",", 2);
  const type = /^data:([^;]+)/.exec(header ?? "")?.[1] ?? "image/jpeg";
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type });
}

function drawScaled(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = FLATTEN_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Remove, or a newer import, while one still decodes: the last action is the one that stays.
let importGeneration = 0;

export async function saveBackgroundImage(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error("Choose an image smaller than 25 MB.");
  const generation = ++importGeneration;
  const bitmap = await createImageBitmap(file);
  try {
    if (generation !== importGeneration) return;
    let image = "";
    for (const [edge, quality] of [
      [MAX_IMAGE_EDGE, 0.85],
      [1280, 0.75],
    ] as const) {
      image = drawScaled(bitmap, edge).toDataURL("image/jpeg", quality);
      if (image.length <= MAX_STORED_IMAGE_LENGTH) break;
    }
    if (image.length > MAX_STORED_IMAGE_LENGTH)
      throw new Error("That image is too detailed to store.");
    const sample = drawScaled(bitmap, SAMPLE_EDGE);
    const pixels = sample.getContext("2d")!.getImageData(0, 0, sample.width, sample.height).data;
    const palette = extractBackgroundPalette(pixels);
    window.localStorage.setItem(BACKGROUND_IMAGE_STORAGE_KEY, JSON.stringify({ image, palette }));
    saveBootColors(palette);
  } finally {
    bitmap.close();
  }
  invalidateBackgroundImage();
}

export function withoutAlpha(color: string): string {
  return color.replace(/\s*\/\s*[^/)]*\)$/, ")");
}

function saveBootColors(palette: BackgroundPalette): void {
  const boot = Object.fromEntries(
    (["light", "dark"] as const).map((appearance) => {
      const { canvas, text, accent } = backgroundImageColors(palette, appearance);
      return [appearance, { background: withoutAlpha(canvas), foreground: text, accent }];
    }),
  );
  // Only the splash reads these, so a full quota costs a flash, not the image.
  try {
    window.localStorage.setItem(BACKGROUND_IMAGE_BOOT_STORAGE_KEY, JSON.stringify(boot));
  } catch {}
}

export function removeBackgroundImage(): void {
  importGeneration += 1;
  window.localStorage.removeItem(BACKGROUND_IMAGE_STORAGE_KEY);
  window.localStorage.removeItem(BACKGROUND_IMAGE_BOOT_STORAGE_KEY);
  invalidateBackgroundImage();
}
