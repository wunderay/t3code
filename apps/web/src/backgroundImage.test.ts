import { converter, formatHex, wcagContrast } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BACKGROUND_IMAGE_BOOT_STORAGE_KEY,
  BACKGROUND_IMAGE_STORAGE_KEY,
  backgroundImageChangedElsewhere,
  backgroundImageColors,
  extractBackgroundPalette,
  getBackgroundImage,
  invalidateBackgroundImage,
  removeBackgroundImage,
  saveBackgroundImage,
  type BackgroundPalette,
} from "./backgroundImage";

const toRgb = converter("rgb");

function pixelsOf(...runs: ReadonlyArray<readonly [count: number, rgb: readonly number[]]>) {
  return Uint8ClampedArray.from(
    runs.flatMap(([count, [r, g, b]]) =>
      Array.from({ length: count }, () => [r!, g!, b!, 255]).flat(),
    ),
  );
}

/** As the browser paints a translucent color over an image pixel, in 8 bits. */
function paintedOver(color: string, pixel: string): string {
  const { r, g, b, alpha = 1 } = toRgb(color)!;
  const under = toRgb(pixel)!;
  const mix = (top: number, bottom: number) => top * alpha + bottom * (1 - alpha);
  return formatHex({ mode: "rgb", r: mix(r, under.r), g: mix(g, under.g), b: mix(b, under.b) });
}

const IMAGES: ReadonlyArray<readonly [string, Uint8ClampedArray]> = [
  ["dark", pixelsOf([700, [12, 18, 40]], [250, [30, 50, 90]], [50, [200, 210, 230]])],
  ["light", pixelsOf([700, [242, 236, 222]], [250, [214, 196, 160]], [50, [40, 34, 28]])],
  ["saturated", pixelsOf([400, [230, 20, 30]], [400, [20, 200, 40]], [200, [250, 230, 0]])],
];

describe("background image palette", () => {
  it("extracts the same palette from the same pixels", () => {
    const pixels = IMAGES[2]![1];
    const palette = extractBackgroundPalette(pixels);
    expect(palette).toEqual({
      base: "#14c828",
      accent: "#e6141e",
      highlight: "#fae600",
      shadow: "#e6141e",
    } satisfies BackgroundPalette);
    expect(extractBackgroundPalette(Uint8ClampedArray.from(pixels))).toEqual(palette);
  });

  it.each(IMAGES)("keeps text readable over a %s image in both appearances", (_, pixels) => {
    const palette = extractBackgroundPalette(pixels);
    for (const appearance of ["light", "dark"] as const) {
      const colors = backgroundImageColors(palette, appearance);
      const worst = appearance === "dark" ? palette.highlight : palette.shadow;
      const canvas = paintedOver(colors.canvas, worst);
      const sidebar = paintedOver(colors.sidebar, worst);
      expect(wcagContrast(colors.text, canvas)).toBeGreaterThanOrEqual(7);
      expect(wcagContrast(colors.textMuted, canvas)).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast(colors.sidebarForeground, sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast(colors.sidebarMutedForeground, sidebar)).toBeGreaterThanOrEqual(4.5);
      for (const [foreground, background] of [
        [colors.messageForeground, colors.messageSurface],
        [colors.secondaryForeground, colors.secondary],
        [colors.accentForeground, colors.accent],
        [colors.messageActionForeground, colors.messageAction],
        [colors.placeholder, colors.surfaceRaised],
      ] as const) {
        expect(wcagContrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("lets a dark image show through dark mode more than light mode", () => {
    const palette = extractBackgroundPalette(IMAGES[0]![1]);
    const opacity = (appearance: "light" | "dark") =>
      toRgb(backgroundImageColors(palette, appearance).canvas)!.alpha ?? 1;
    expect(opacity("dark")).toBeLessThan(opacity("light"));
  });
});

describe("background image theme", () => {
  it("restores the chosen theme exactly when the image is removed or unreadable", async () => {
    const palette = extractBackgroundPalette(IMAGES[2]![1]);
    const stored = (image: string) => JSON.stringify({ image, palette });
    const storage = new Map<string, string>([
      ["t3code:theme", "grove"],
      ["t3code:theme-appearance-mode", "dark"],
      [BACKGROUND_IMAGE_STORAGE_KEY, stored("data:image/jpeg;base64,!!!")],
    ]);
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      classList: { add() {}, remove() {}, toggle() {} },
      offsetHeight: 0,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    };
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      await import("./hooks/useTheme");
      const chosen = { themeId: root.dataset.themeId, properties: new Map(properties) };
      expect(chosen.themeId).toBe("grove");
      expect(root.dataset.backgroundImage).toBeUndefined();
      // Base64 of an impossible length passes the pattern but fails to decode.
      storage.set(BACKGROUND_IMAGE_STORAGE_KEY, stored("data:image/jpeg;base64,AAAAA"));
      invalidateBackgroundImage();
      expect({ themeId: root.dataset.themeId, properties }).toEqual(chosen);
      expect(root.dataset.backgroundImage).toBeUndefined();

      storage.set(BACKGROUND_IMAGE_STORAGE_KEY, stored("data:image/jpeg;base64,AAAA"));
      invalidateBackgroundImage();
      expect(root.dataset.themeId).not.toBe("grove");
      expect(root.dataset.backgroundImage).toBe("");
      expect(properties.get("--app-theme-canvas")).toBe(
        backgroundImageColors(palette, "dark").canvas,
      );

      removeBackgroundImage();
      expect(storage.get("t3code:theme")).toBe("grove");
      expect(root.dataset.backgroundImage).toBeUndefined();
      expect({ themeId: root.dataset.themeId, properties }).toEqual(chosen);
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });
});

function stubImageImport(storage: Map<string, string>, failingKey?: string) {
  const contexts: Array<{ fillStyle: string; operations: string[] }> = [];
  const createImageBitmap = vi.fn(async () => ({ width: 400, height: 200, close() {} }));
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  // useTheme, loaded by an earlier test, repaints this root when the image changes.
  const documentElement = {
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {}, removeProperty() {} },
  };
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("document", {
    documentElement,
    createElement: () => {
      const context = {
        fillStyle: "",
        operations: [] as string[],
        fillRect() {
          this.operations.push(`fill ${this.fillStyle}`);
        },
        drawImage() {
          this.operations.push("draw");
        },
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      };
      contexts.push(context);
      return { width: 0, height: 0, getContext: () => context, toDataURL: () => IMAGE };
    },
  });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === failingKey) throw new DOMException("Quota exceeded", "QuotaExceededError");
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
  });
  return { contexts, createImageBitmap };
}

const IMAGE = "data:image/jpeg;base64,AAAA";
const image = (type: string, size: number) => ({ type, size }) as File;

describe("saving a background image", () => {
  it("refuses files that are not images or are too large, before decoding them", async () => {
    const { createImageBitmap } = stubImageImport(new Map());
    try {
      await expect(saveBackgroundImage(image("text/plain", 10))).rejects.toThrow("image file");
      await expect(saveBackgroundImage(image("image/png", 26 * 1024 * 1024))).rejects.toThrow(
        "25 MB",
      );
      expect(createImageBitmap).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });

  it("keeps the previous image and theme when storage is full", async () => {
    const previous = JSON.stringify({
      image: IMAGE,
      palette: extractBackgroundPalette(IMAGES[0]![1]),
    });
    const storage = new Map([
      ["t3code:theme", "grove"],
      [BACKGROUND_IMAGE_STORAGE_KEY, previous],
    ]);
    stubImageImport(storage, BACKGROUND_IMAGE_STORAGE_KEY);
    try {
      const before = getBackgroundImage();
      await expect(saveBackgroundImage(image("image/png", 1000))).rejects.toThrow("Quota");
      expect(Object.fromEntries(storage)).toEqual({
        "t3code:theme": "grove",
        [BACKGROUND_IMAGE_STORAGE_KEY]: previous,
      });
      expect(getBackgroundImage()).toBe(before);
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });

  it("samples the picture as stored: flattened onto one color, with boot colors saved", async () => {
    const storage = new Map<string, string>();
    const { contexts } = stubImageImport(storage);
    try {
      await saveBackgroundImage(image("image/png", 1000));
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      for (const context of contexts) expect(context.operations).toEqual(["fill #ffffff", "draw"]);
      const saved = getBackgroundImage()!;
      expect(saved.palette.base).toBe("#ffffff");
      expect(JSON.parse(storage.get(BACKGROUND_IMAGE_BOOT_STORAGE_KEY)!)).toEqual({
        light: expect.objectContaining({ background: expect.any(String) }),
        dark: expect.objectContaining({ background: expect.any(String) }),
      });
      removeBackgroundImage();
      expect(storage.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });

  it("stays removed when Remove is pressed while a replacement is still decoding", async () => {
    const storage = new Map<string, string>();
    const { createImageBitmap } = stubImageImport(storage);
    try {
      await saveBackgroundImage(image("image/png", 1000));
      const bitmap = { width: 400, height: 200, close() {} };
      let finishDecoding!: (decoded: typeof bitmap) => void;
      createImageBitmap.mockImplementationOnce(
        () => new Promise<typeof bitmap>((resolve) => (finishDecoding = resolve)),
      );
      const replacing = saveBackgroundImage(image("image/png", 1000));
      removeBackgroundImage();
      finishDecoding(bitmap);
      await replacing;
      expect(storage.size).toBe(0);
      expect(getBackgroundImage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });

  it("keeps another tab's removal when an import here finishes decoding afterwards", async () => {
    const storage = new Map<string, string>();
    const { createImageBitmap } = stubImageImport(storage);
    try {
      await saveBackgroundImage(image("image/png", 1000));
      const bitmap = { width: 400, height: 200, close() {} };
      let finishDecoding!: (decoded: typeof bitmap) => void;
      createImageBitmap.mockImplementationOnce(
        () => new Promise<typeof bitmap>((resolve) => (finishDecoding = resolve)),
      );
      const replacing = saveBackgroundImage(image("image/png", 1000));
      // The other tab removed the image; this tab only hears the storage event.
      storage.clear();
      backgroundImageChangedElsewhere();
      finishDecoding(bitmap);
      await replacing;
      expect(storage.size).toBe(0);
      expect(getBackgroundImage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      invalidateBackgroundImage();
    }
  });
});
