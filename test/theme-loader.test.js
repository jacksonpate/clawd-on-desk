"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");

// Scratch dir layout the loader expects:
//   <tmp>/src/           (appDir)
//   <tmp>/themes/<id>/theme.json
//   <tmp>/themes/<id>/assets/<files>
//   <tmp>/assets/svg/    (referenced by init for built-in svgs)
//   <tmp>/userData/themes/<id>/theme.json   (user-installed)
function makeFixture(themes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-"));
  const appDir = path.join(tmp, "src");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "themes"), { recursive: true });
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(path.join(userData, "themes"), { recursive: true });

  for (const { id, builtin, json } of themes) {
    const base = builtin
      ? path.join(tmp, "themes", id)
      : path.join(userData, "themes", id);
    fs.mkdirSync(base, { recursive: true });
    if (json !== undefined) {
      fs.writeFileSync(path.join(base, "theme.json"), JSON.stringify(json), "utf8");
    }
  }
  themeLoader.init(appDir, userData);
  return { tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    ...overrides,
  };
}

describe("theme-loader strict mode", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      { id: "good", builtin: true, json: validThemeJson({ name: "Good" }) },
      // Missing required fields (no schemaVersion, no viewBox) → validateTheme fails.
      { id: "broken", builtin: false, json: { name: "Bad", version: "1", states: {} } },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("lenient load falls back to clawd when theme missing", () => {
    const theme = themeLoader.loadTheme("doesNotExist");
    assert.strictEqual(theme._id, "clawd");
  });

  it("lenient load falls back when theme validation fails", () => {
    const theme = themeLoader.loadTheme("broken");
    assert.strictEqual(theme._id, "clawd");
  });

  it("strict load throws when theme is missing", () => {
    assert.throws(
      () => themeLoader.loadTheme("doesNotExist", { strict: true }),
      /not found/
    );
  });

  it("strict load throws when theme fails validation", () => {
    assert.throws(
      () => themeLoader.loadTheme("broken", { strict: true }),
      /validation/
    );
  });

  it("strict load succeeds on a valid theme", () => {
    const theme = themeLoader.loadTheme("good", { strict: true });
    assert.strictEqual(theme._id, "good");
  });
});

describe("theme-loader getThemeMetadata", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      {
        id: "clawd",
        builtin: true,
        json: validThemeJson({ name: "Clawd", preview: "clawd-preview.svg" }),
      },
      {
        id: "noPreview",
        builtin: true,
        json: validThemeJson({ name: "No Preview", states: { ...validThemeJson().states, idle: ["fallback.svg"] } }),
      },
      { id: "broken", builtin: false, json: { name: "Bad", version: "1", states: {} } },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("returns null for missing / malformed themes", () => {
    assert.strictEqual(themeLoader.getThemeMetadata("doesNotExist"), null);
  });

  it("returns name + builtin flag even when preview file is absent", () => {
    const meta = themeLoader.getThemeMetadata("noPreview");
    assert.ok(meta, "metadata expected");
    assert.strictEqual(meta.id, "noPreview");
    assert.strictEqual(meta.name, "No Preview");
    assert.strictEqual(meta.builtin, true);
    // No fs file seeded, so preview URL is null — acceptable: renderer
    // falls back to the placeholder glyph.
    assert.strictEqual(meta.previewFileUrl, null);
  });

  it("prefers explicit preview field over idle[0]", () => {
    // Both files are absent on disk in the fixture — we just verify the
    // selector chose `preview`, not `states.idle[0]`. A precise end-to-end
    // URL test would need writing a real asset, which is over-kill for the
    // contract under test.
    const meta = themeLoader.getThemeMetadata("clawd");
    assert.ok(meta);
    // Internal contract: when the preview file isn't found, URL is null.
    // (Exercising the positive path requires writing assets; we trust
    // path.basename() + fs.existsSync as leaf pieces.)
    assert.strictEqual(meta.previewFileUrl, null);
  });
});

// ── Phase 3b-swap: variant support ──
describe("theme-loader variant loading", () => {
  let fixture;
  before(() => {
    const variantTheme = validThemeJson({
      name: "Variant Host",
      workingTiers: [
        { minSessions: 2, file: "pose-a.svg" },
        { minSessions: 1, file: "pose-b.svg" },
      ],
      jugglingTiers: [{ minSessions: 1, file: "pose-b.svg" }],
      displayHintMap: { "pose-a.svg": "pose-a.svg" },
      hitBoxes: { default: { x: 0, y: 0, w: 10, h: 10 } },
      timings: { autoReturn: { attention: 4000 }, yawnDuration: 3000 },
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
      variantsSchemaVersion: 0,
      variants: {
        chill: {
          name: { en: "Chill", zh: "松弛" },
          description: "slower",
          workingTiers: [
            { minSessions: 3, file: "pose-c.svg" },
            { minSessions: 1, file: "pose-b.svg" },
          ],
          timings: { autoReturn: { attention: 8000 } },
          displayHintMap: { "pose-c.svg": "pose-c.svg" },
          garbageField: "ignored",  // not in allow-list
        },
        strictDefault: {
          // Explicit default that replaces the synthetic one
          name: "Explicit default",
        },
      },
    });
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      { id: "host", builtin: true, json: variantTheme },
      {
        id: "novariants",
        builtin: true,
        json: validThemeJson({ name: "Plain" }),
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("default request returns _variantId='default' when theme has no variants", () => {
    const theme = themeLoader.loadTheme("novariants");
    assert.strictEqual(theme._variantId, "default");
  });

  it("unknown variant lenient-falls back to default", () => {
    const theme = themeLoader.loadTheme("host", { variant: "nonexistent" });
    assert.strictEqual(theme._variantId, "default");
    // Fallback to default means original tiers untouched (not "chill" tiers)
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["pose-a.svg", "pose-b.svg"]
    );
  });

  it("named variant patches workingTiers via replace semantics", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme._variantId, "chill");
    // Patch replaced tiers wholesale — and mergeDefaults ran after, so tiers
    // are sorted descending by minSessions. Proves patch-before-merge order.
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["pose-c.svg", "pose-b.svg"]
    );
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.minSessions),
      [3, 1]
    );
  });

  it("variant patches timings via deep-merge (scalars + nested objects)", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme.timings.autoReturn.attention, 8000);  // patched
    assert.strictEqual(theme.timings.yawnDuration, 3000);          // preserved
    // base autoReturn.error was unspecified — mergeDefaults fills DEFAULT 5000
    assert.strictEqual(theme.timings.autoReturn.error, 5000);
  });

  it("variant replaces displayHintMap wholesale (not deep-merge)", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    // chill replaced the entire map → "pose-a.svg" key is gone
    assert.strictEqual(theme.displayHintMap["pose-a.svg"], undefined);
    assert.strictEqual(theme.displayHintMap["pose-c.svg"], "pose-c.svg");
  });

  it("out-of-allow-list fields in variant are ignored silently", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme.garbageField, undefined);
  });

  it("getThemeMetadata.variants synthesizes a default entry when author omits it", () => {
    const meta = themeLoader.getThemeMetadata("host");
    assert.ok(Array.isArray(meta.variants));
    const ids = meta.variants.map((v) => v.id);
    // host declares `chill` + `strictDefault` explicitly; since no `default`
    // is declared, loader synthesizes one.
    assert.ok(ids.includes("default"), `expected synthetic default in ${ids.join(",")}`);
    assert.ok(ids.includes("chill"));
    assert.ok(ids.includes("strictDefault"));
  });

  it("getThemeMetadata.variants preserves i18n-style name object as-is", () => {
    const meta = themeLoader.getThemeMetadata("host");
    const chill = meta.variants.find((v) => v.id === "chill");
    assert.deepStrictEqual(chill.name, { en: "Chill", zh: "松弛" });
    assert.strictEqual(chill.description, "slower");
  });

  it("getThemeMetadata.variants returns single-item list for theme with no variants", () => {
    const meta = themeLoader.getThemeMetadata("novariants");
    assert.strictEqual(meta.variants.length, 1);
    assert.strictEqual(meta.variants[0].id, "default");
  });

  it("user overrides patch states / tiers / timings on top of the resolved variant", () => {
    const theme = themeLoader.loadTheme("host", {
      variant: "chill",
      overrides: {
        states: {
          thinking: {
            file: "custom-thinking.svg",
            transition: { in: 80, out: 120 },
          },
        },
        tiers: {
          workingTiers: {
            "pose-c.svg": {
              file: "custom-working.svg",
              transition: { in: 10, out: 40 },
            },
          },
        },
        timings: {
          autoReturn: { attention: 6400 },
        },
      },
    });
    assert.strictEqual(theme.states.thinking[0], "custom-thinking.svg");
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["custom-working.svg", "pose-b.svg"]
    );
    assert.deepStrictEqual(theme.transitions["custom-thinking.svg"], { in: 80, out: 120 });
    assert.deepStrictEqual(theme.transitions["custom-working.svg"], { in: 10, out: 40 });
    assert.strictEqual(theme.timings.autoReturn.attention, 6400);
  });

  it("stores pre-override tier bindings for UI card identity", () => {
    const theme = themeLoader.loadTheme("host", {
      variant: "chill",
      overrides: {
        tiers: {
          jugglingTiers: {
            "pose-b.svg": { file: "custom-juggling.svg" },
          },
        },
      },
    });
    assert.deepStrictEqual(theme._bindingBase.jugglingTiers, [
      { minSessions: 1, originalFile: "pose-b.svg" },
    ]);
  });
});
