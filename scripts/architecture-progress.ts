/**
 * Architecture and progress dashboard for the native track.
 *
 * One source of truth (`architecture`), one renderer (`renderArchitecture`),
 * one generated artifact: docs-site/static/architecture-progress.html. Update
 * the data after a milestone, then run `bun run architecture:build`. The test in
 * tests/architecture-progress.test.ts fails when the committed page is stale.
 *
 * The page is dependency-free: inline CSS, inline SVG, one small script for
 * hover details. It is designed to fit a 1280x800 laptop viewport without
 * scrolling and to stay readable when it cannot.
 */

export type State = "done" | "partial" | "planned";

export interface Chip {
  readonly label: string;
  readonly state: State;
}

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly kicker: string;
  readonly percent: number;
  readonly chips: readonly Chip[];
  readonly shipped: readonly string[];
  readonly open: readonly string[];
  readonly evidence: string;
}

export interface Milestone {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly done: number;
  readonly total: number;
  readonly state: State;
}

export interface Architecture {
  readonly updated: string;
  readonly goal: string;
  readonly subline: string;
  readonly tests: number;
  readonly gated: number;
  readonly g2: number;
  readonly m1Budget: number;
  readonly m1Covered: number;
  readonly stats: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly layers: readonly Layer[];
  readonly milestones: readonly Milestone[];
  readonly recent: ReadonlyArray<{ readonly hash: string; readonly text: string }>;
  readonly next: readonly string[];
  readonly decisions: readonly string[];
}

export const architecture: Architecture = {
  updated: "2026-10-28 · M1 ABI measured, symbols 31/31",
  goal: "Run an unmodified iOS app on a non-Apple host",
  subline:
    "Two tracks: shim-linked apps (G1, shipping) and stock SDK binaries (G2, gated by the measured symbol budget).",
  tests: 164,
  gated: 6,
  g2: 8,
  m1Budget: 31,
  m1Covered: 31,
  stats: [
    { value: "164", label: "hermetic tests" },
    { value: "6", label: "macOS-gated" },
    { value: "33", label: "host classes" },
    { value: "36", label: "runtime symbols" },
  ],
  layers: [
    {
      id: "ipa",
      name: "Unmodified .ipa",
      kicker: "G2 · a stock SDK binary, no shim",
      percent: 8,
      chips: [
        { label: "symbol budget", state: "done" },
        { label: "no Apple runtime", state: "partial" },
        { label: "replacement images", state: "planned" },
      ],
      shipped: [
        "ADR 0008 and the readiness plan record the goal and the gate",
        "All 31 symbols covered; ivar-slot ABI contract measured",
        "App-bundle directories launch through Info.plist",
      ],
      open: [
        "Constant CFString and literal collection classes",
        "Binary-compatible Foundation/UIKit subset (13 classes)",
        "Apple dylib replacement images and a Swift path",
      ],
      evidence: "scripts/spike-ios-symbols.ts · docs/plans/ipa-readiness.md",
    },
    {
      id: "app",
      name: "App surface",
      kicker: "Bundles · resources · scripted input",
      percent: 82,
      chips: [
        { label: ".app launch", state: "done" },
        { label: "Info.plist", state: "done" },
        { label: "resources", state: "done" },
        { label: "scenes", state: "planned" },
      ],
      shipped: [
        ".app directories: CFBundleExecutable, bundle jail, metadata in JSON",
        "NSBundle resource lookup shared with UIImage",
        "Scripted taps, drags, ticks and NSLog on stderr",
      ],
      open: [
        "Install/launch services and URL open",
        "Scene lifecycle, state restoration, localization",
        "Assets.car and storyboard/nib loading",
      ],
      evidence: "packages/darwin-compat/src/app/bundle.ts · objc/host.ts",
    },
    {
      id: "uikit",
      name: "UIKit shim",
      kicker: "Views · controls · controllers",
      percent: 80,
      chips: [
        { label: "views", state: "done" },
        { label: "controls", state: "done" },
        { label: "segments", state: "done" },
        { label: "gestures", state: "done" },
        { label: "text", state: "done" },
        { label: "progress", state: "done" },
        { label: "images", state: "done" },
        { label: "navigation", state: "done" },
        { label: "tables", state: "done" },
      ],
      shipped: [
        "View tree, hit-testing, clipping, scroll drags, responder forwarding",
        "Label (bitmap, wrapping), button, switch, slider, segments, image view",
        "Navigation controller, row-based table, progress view",
        "Legacy and block animations on the virtual clock",
      ],
      open: [
        "Table cells/delegate, UICollectionView, tabs, animated transitions",
        "Auto Layout, transforms, CALayer, multiple windows",
        "Alert/action sheets, text fields, keyboard",
      ],
      evidence: "objc/host.ts · objc/host.test.ts · tests/native/objc-clang.test.ts",
    },
    {
      id: "output",
      name: "Compositor & frames",
      kicker: "Deterministic software rendering",
      percent: 56,
      chips: [
        { label: "RGBA buffer", state: "done" },
        { label: "PNG/PPM", state: "done" },
        { label: "corner radius", state: "done" },
        { label: "transforms", state: "done" },
        { label: "masks", state: "planned" },
        { label: "window", state: "planned" },
      ],
      shipped: [
        "Alpha rect fills, clipping, rounded corners, transforms, images, text",
        "Stable digests, de-duplicated frames, bounded capture",
      ],
      open: [
        "Layer masks, opacity composition, gradients",
        "CoreAnimation timing, CADisplayLink, GPU or faster software path",
        "JPEG/HEIC/Assets.car, CoreText metrics, host window or stream",
      ],
      evidence: "ui/framebuffer.ts · ui/png.ts · ui/font.ts",
    },
    {
      id: "foundation",
      name: "Foundation shim",
      kicker: "The objects apps share",
      percent: 70,
      chips: [
        { label: "NSString", state: "done" },
        { label: "NSData", state: "done" },
        { label: "formatting", state: "done" },
        { label: "JSON", state: "done" },
        { label: "CF strings", state: "done" },
        { label: "literals", state: "done" },
        { label: "collections", state: "done" },
        { label: "timers", state: "done" },
        { label: "bundle", state: "done" },
        { label: "NSData/URL", state: "planned" },
        { label: "KVC/KVO", state: "planned" },
      ],
      shipped: [
        "NSString, NSNumber, NSArray/NSMutableArray, NSDictionary/NSMutableDictionary",
        "NSUserDefaults, notifications with userInfo, NSTimer, delayed perform",
        "NSBundle, formatted NSLog, NSData, JSON, constant strings/collections, PNG",
      ],
      open: [
        "NSDate, NSURL, NSError, NSFileManager",
        "NSKeyedArchiver, NSOperation/GCD, NSRunLoop",
        "KVC/KVO, NSInvocation",
      ],
      evidence: "objc/host.ts · ui/png.ts · runtime/process.ts",
    },
    {
      id: "objc",
      name: "Objective-C runtime",
      kicker: "Apple ABI semantics on the host",
      percent: 76,
      chips: [
        { label: "metadata", state: "done" },
        { label: "dispatch", state: "done" },
        { label: "ARC", state: "done" },
        { label: "blocks", state: "done" },
        { label: "exceptions", state: "planned" },
        { label: "swizzling", state: "planned" },
      ],
      shipped: [
        "Class/method/ivar/protocol metadata, categories, absolute + relative lists",
        "objc_msgSend/Super2, +load, +initialize, associated objects, zeroing weak",
        "Retain/release refcounts, pools, guest -dealloc, block literals",
      ],
      open: [
        "Exceptions: objc_exception_throw, catch/end-catch, unwinding",
        "Swizzling, property helpers, objc_getClassList, class_addMethod",
        "Reclamation and a real allocator; per-thread pools",
      ],
      evidence: "objc/abi.ts · objc/host.ts · objc/inspect.ts",
    },
    {
      id: "dyld",
      name: "User-space dyld",
      kicker: "Map and bind Mach-O images",
      percent: 72,
      chips: [
        { label: "chained", state: "done" },
        { label: "legacy", state: "done" },
        { label: "fat", state: "done" },
        { label: "cache", state: "planned" },
      ],
      shipped: [
        "Thin/fat parsing, segments, sections, symbols, exports trie",
        "Chained fixups (arm64e decoded) and legacy LC_DYLD_INFO",
        "Multi-page mapping fix, dependency search, entry points",
      ],
      open: [
        "dyld shared cache mapping and system dylibs",
        "dlopen, threaded binds, weak/lazy edge cases",
        "Code-signature validation or a documented bypass",
      ],
      evidence: "dyld/loader.ts · macho/* · dyld/vm.ts",
    },
    {
      id: "kernel",
      name: "Kernel & syscalls",
      kicker: "The Darwin surface programs touch",
      percent: 46,
      chips: [
        { label: "30 syscalls", state: "done" },
        { label: "Mach IPC", state: "done" },
        { label: "launchd", state: "done" },
        { label: "threads", state: "planned" },
        { label: "sockets", state: "planned" },
      ],
      shipped: [
        "VM, file jail, stdio, mmap, time, entropy",
        "Mach ports/rights, MIG-lite, XPC-style RPC, launchd jobs",
      ],
      open: [
        "Threads and blocking Mach receives",
        "Signals, sockets, kqueue, fstat, posix_spawn",
        "Byte-compatible XPC/MIG and real VM objects",
      ],
      evidence: "syscall/kernel.ts · mach/* · launchd/*",
    },
    {
      id: "cpu",
      name: "arm64 execution",
      kicker: "Interpreter, not a JIT",
      percent: 70,
      chips: [
        { label: "integer", state: "done" },
        { label: "FP/SIMD", state: "done" },
        { label: "atomics", state: "done" },
        { label: "JIT", state: "planned" },
      ],
      shipped: [
        "Integer, branches, loads/stores, flags, syscall traps",
        "Scalar FP/SIMD, atomics, TLS, exclusive access",
        "PAC fields decoded, not enforced",
      ],
      open: [
        "Full SIMD lane arithmetic and remaining addressing modes",
        "JIT or AOT for realistic workloads",
        "arm64e enforcement",
      ],
      evidence: "arm64/cpu.ts · arm64/assembler.ts",
    },
  ],
  milestones: [
    {
      id: "m1",
      name: "M1 · one stock-SDK app",
      detail: "Symbols 31/31; realize-and-patch next.",
      done: 2,
      total: 7,
      state: "partial",
    },
    {
      id: "m2",
      name: "M2 · a chosen app family",
      detail: "Two or three small real apps, matrix documented.",
      done: 0,
      total: 6,
      state: "planned",
    },
    {
      id: "m3",
      name: "M3 · platform breadth",
      detail: "Graphics, input, media, entitlements, host window.",
      done: 0,
      total: 5,
      state: "planned",
    },
  ],
  recent: [
    { hash: "ac9f5ab", text: "Stock-app ABI measured: ivar offsets are patched slots" },
    { hash: "82992a0", text: "Ivar offsets read through ivar_t pointers" },
    { hash: "a65b0c3", text: "M1 symbol surface closed: 31/31 with UIScreen + responder" },
    { hash: "b6bc8af", text: "Literal @[] / @{} collections with measured layouts" },
    { hash: "193c25d", text: "UIProgressView with float progress and fill" },
    { hash: "8ddaf21", text: 'Constant @"..." string literals via CFString reference' },
    { hash: "0a84fd3", text: "Affine transforms on view backgrounds" },
    { hash: "af15ed7", text: "UITableView rows, selection, and scroll offset" },
    { hash: "4c1f090", text: "UINavigationController push/pop with host chrome" },
    { hash: "6033504", text: "NSJSONSerialization + dataUsingEncoding" },
    { hash: "617591e", text: "UISegmentedControl selection and rendering" },
    { hash: "0d18a9e", text: "stringWithFormat + formatted NSLog (stack varargs)" },
    { hash: "754f212", text: "CALayer corner radius on view backgrounds" },
    { hash: "22dc12a", text: "NSData + UIImage imageWithData, data-backed images" },
    { hash: "fd7f190", text: "Block literals bind; block-based view animations" },
    { hash: "b851832", text: "Multi-page segment mapping fix in the loader" },
    { hash: "e9c2c6c", text: "Tap and pan gesture recognisers" },
    { hash: "df83c03", text: ".app bundle directories launch end to end" },
    { hash: "d9b6fe9", text: "NSBundle resource lookup" },
    { hash: "b61e348", text: "Responder forwarding and scroll drags" },
    { hash: "cc3f742", text: "UIImage/UIImageView with a PNG decoder" },
  ],
  next: [
    "UINavigationController + UITableView-lite",
    "Exceptions and unwinding",
    "Threads + a libdispatch subset",
    "Compositor v2: layers, transforms, host window",
    "M1 replacement images (13 classes, 8 entry points)",
  ],
  decisions: [
    "Host-side ObjC semantics, not libobjc2",
    "Clean-room shim keeps its own ivar layout",
    "Headless deterministic frames before a window",
    "Unmodified binaries only through a measured budget",
  ],
};

const STATUS_COLOR: Record<State, string> = {
  done: "var(--green)",
  partial: "var(--amber)",
  planned: "var(--slate)",
};

function overallG1(data: Architecture): number {
  const g1 = data.layers.filter((layer) => layer.id !== "ipa");
  return Math.round(g1.reduce((sum, layer) => sum + layer.percent, 0) / g1.length);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chip(chip: Chip, index: number): string {
  return `<span class="chip" style="--dot:${STATUS_COLOR[chip.state]};--i:${index}">${escapeHtml(
    chip.label,
  )}</span>`;
}

function layerRow(layer: Layer, index: number): string {
  const visible = layer.chips.slice(0, 4);
  const extra = layer.chips.length - visible.length;
  return `<div class="layer" role="button" tabindex="0" data-layer="${layer.id}" aria-label="${escapeHtml(
    layer.name,
  )}, ${layer.percent}%">
    <div class="layerRail"><span class="node" style="--dot:${dotFor(layer.percent)}"></span><span class="ordinal">${String(
      index + 1,
    ).padStart(2, "0")}</span></div>
    <div class="layerMain">
      <div class="layerTitle"><span>${escapeHtml(layer.name)}</span><span class="pct">${layer.percent}%</span></div>
      <div class="layerKicker">${escapeHtml(layer.kicker)}</div>
      <div class="chips">${visible.map(chip).join("")}${
        extra > 0 ? `<span class="chip more">+${extra}</span>` : ""
      }</div>
      <div class="bar" aria-hidden="true"><span style="--p:${layer.percent / 100};--dot:${dotFor(
        layer.percent,
      )}"></span></div>
    </div>
  </div>`;
}

function dotFor(percent: number): string {
  if (percent >= 70) return "var(--green)";
  if (percent >= 40) return "var(--amber)";
  return "var(--rose)";
}

function milestoneRow(milestone: Milestone): string {
  return `<div class="milestone">
    <span class="msDot" style="--dot:${STATUS_COLOR[milestone.state]}"></span>
    <div class="msText"><b>${escapeHtml(milestone.name)}${
      milestone.state === "partial" ? '<i class="msTag">in progress</i>' : ""
    }</b><span>${escapeHtml(milestone.detail)}</span></div>
    <span class="msCount">${milestone.done}/${milestone.total}</span>
  </div>`;
}

/** Render the complete dashboard. Deterministic: same data, same bytes. */
export function renderArchitecture(data: Architecture = architecture): string {
  const g1 = overallG1(data);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - g1 / 100);
  const detailDefault = `<div class="cardTitle"><span>Recent progress</span><span>hover a layer to inspect</span></div>
    <div class="recent">${data.recent
      .map(
        (entry) =>
          `<div class="recentRow"><code>${escapeHtml(entry.hash)}</code><span>${escapeHtml(
            entry.text,
          )}</span></div>`,
      )
      .join("")}</div>
    <div class="decisions">${data.decisions
      .map((decision) => `<span>${escapeHtml(decision)}</span>`)
      .join("")}</div>
    <div class="gate"><span>M1 gate</span><b>2 / 7</b><em>next: replacement images</em></div>`;
  const payload = JSON.stringify({
    layers: data.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kicker: layer.kicker,
      percent: layer.percent,
      shipped: layer.shipped,
      open: layer.open,
      evidence: layer.evidence,
    })),
  }).replaceAll("</", "<\\/");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Architecture & progress · ios-sim native track</title>
<meta name="description" content="What the native track aims to build, what is shipped, and what is next." />
<style>
:root {
  color-scheme: dark;
  --bg: #060a12;
  --ink: #e9eefb;
  --muted: #93a4c1;
  --dim: #64748b;
  --line: rgba(148, 163, 184, 0.14);
  --card: rgba(14, 22, 39, 0.72);
  --card2: rgba(17, 26, 45, 0.6);
  --green: #34d399;
  --amber: #fbbf24;
  --rose: #fb7185;
  --slate: #64748b;
  --cyan: #22d3ee;
  --violet: #a78bfa;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
body::before {
  content: "";
  position: fixed;
  inset: -20%;
  background:
    radial-gradient(46% 42% at 12% 8%, rgba(34, 211, 238, 0.16), transparent 70%),
    radial-gradient(40% 40% at 88% 0%, rgba(167, 139, 250, 0.16), transparent 70%),
    radial-gradient(50% 50% at 60% 108%, rgba(52, 211, 153, 0.09), transparent 70%);
  pointer-events: none;
  z-index: 0;
}
body::after {
  content: "";
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.055) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(80% 70% at 50% 40%, #000 40%, transparent 100%);
  pointer-events: none;
  z-index: 0;
}
.shell {
  position: relative;
  z-index: 1;
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  padding: 18px 22px 12px;
  max-width: 1560px;
  margin: 0 auto;
}
header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
.brand { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; }
.brand .mark { color: var(--cyan); font-size: 15px; text-shadow: 0 0 18px rgba(34, 211, 238, 0.7); }
h1 {
  margin: 6px 0 4px;
  font-size: clamp(20px, 2.1vw, 30px);
  line-height: 1.08;
  letter-spacing: -0.02em;
  font-weight: 650;
  background: linear-gradient(92deg, #f8fbff 10%, var(--cyan) 45%, var(--violet) 95%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lede { margin: 0; color: var(--muted); font-size: 12px; max-width: 74ch; }
.meta { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 11px; white-space: nowrap; }
.meta .pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; color: var(--muted); }
.stats { display: flex; gap: 8px; }
.stat {
  min-width: 74px; border: 1px solid var(--line); border-radius: 12px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015));
  padding: 7px 10px;
}
.stat b { display: block; font-size: 16px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.stat span { color: var(--dim); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.12em; }
main { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.85fr); gap: 14px; min-height: 0; }
.card {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--card), var(--card2));
  box-shadow: 0 22px 60px rgba(2, 6, 23, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(14px);
}
.stack { padding: 10px 12px 12px; display: grid; grid-template-rows: auto repeat(${data.layers.length}, minmax(0, 1fr)); gap: 5px; min-height: 0; position: relative; }
.stack::before {
  content: ""; position: absolute; left: 24px; top: 48px; bottom: 26px; width: 1px;
  background: linear-gradient(180deg, rgba(34, 211, 158, 0.45), rgba(34, 211, 238, 0.22) 45%, rgba(167, 139, 250, 0.12));
  pointer-events: none;
}
.stackHead { display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); padding: 0 4px 5px; }
.stackHead b { color: var(--muted); font-weight: 500; letter-spacing: 0.12em; }
.layer {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 6px 9px 6px 4px;
  border: 1px solid transparent;
  border-radius: 11px;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.layer:hover, .layer:focus-visible, .layer.active {
  background: rgba(255, 255, 255, 0.045);
  border-color: rgba(148, 163, 184, 0.22);
  transform: translateX(2px);
  outline: none;
}
.layerRail { display: flex; flex-direction: column; align-items: center; gap: 2px; align-self: stretch; justify-content: center; }
.node { width: 7px; height: 7px; border-radius: 50%; background: var(--dot); box-shadow: 0 0 12px color-mix(in srgb, var(--dot) 70%, transparent); }
.ordinal { font-family: var(--mono); font-size: 8.5px; color: var(--dim); }
.layerMain { min-width: 0; }
.layerTitle { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; font-weight: 600; letter-spacing: -0.01em; }
.layerTitle .pct { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
.layerKicker { color: var(--dim); font-size: 9.5px; margin: 1px 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chips { display: flex; gap: 4px; flex-wrap: nowrap; overflow: hidden; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--line); border-radius: 999px;
  padding: 1px 6px 1px 5px; font-size: 9px; color: var(--muted);
  background: rgba(2, 6, 23, 0.35);
}
body.ready .chip {
  animation: rise 420ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--i, 0) * 40ms + 80ms);
}
.chip::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--dot); }
.chip.more { color: var(--dim); }
.bar { margin-top: 6px; height: 3px; border-radius: 99px; background: rgba(148, 163, 184, 0.2); overflow: hidden; }
.bar span {
  display: block; height: 100%; width: 100%;
  transform-origin: left; transform: scaleX(var(--p));
  background: linear-gradient(90deg, color-mix(in srgb, var(--dot) 65%, #0f172a), var(--dot));
  box-shadow: 0 0 10px color-mix(in srgb, var(--dot) 55%, transparent);
}
body.ready .bar span { animation: grow 900ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
aside { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 12px; min-height: 0; }
.mission { padding: 12px 14px; display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 12px; align-items: center; }
.ringWrap { position: relative; width: 132px; height: 132px; }
.ringWrap svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ringTrack { fill: none; stroke: rgba(148, 163, 184, 0.16); stroke-width: 9; }
.ringFill {
  fill: none; stroke: url(#ringGrad); stroke-width: 9; stroke-linecap: round;
  stroke-dasharray: ${circumference.toFixed(2)};
  stroke-dashoffset: ${offset.toFixed(2)};
  filter: drop-shadow(0 0 8px rgba(52, 211, 153, 0.45));
}
body.ready .ringFill { animation: ring 1100ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
.ringText { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.ringText b { font-size: 27px; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.ringText span { color: var(--dim); font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.16em; margin-top: 4px; }
.missionText b { display: block; font-size: 12px; }
.missionText p { margin: 3px 0 7px; color: var(--muted); font-size: 10.5px; line-height: 1.45; }
.track { display: grid; gap: 4px; margin-top: 6px; }
.trackRow { display: grid; grid-template-columns: 52px minmax(0, 1fr) 30px; align-items: center; gap: 7px; font-size: 9px; color: var(--dim); }
.trackBar { height: 4px; border-radius: 99px; background: rgba(148, 163, 184, 0.16); overflow: hidden; }
.trackBar span { display: block; height: 100%; transform-origin: left; transform: scaleX(var(--p)); }
body.ready .trackBar span { animation: grow 900ms 200ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
.trackRow b { font-family: var(--mono); font-size: 9px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.milestones { padding: 10px 12px; display: grid; gap: 5px; }
.cardTitle { display: flex; justify-content: space-between; align-items: baseline; font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); padding: 0 2px 3px; }
.milestone { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 2px 2px; }
.msDot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot); box-shadow: 0 0 10px color-mix(in srgb, var(--dot) 60%, transparent); }
.msText b { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 550; }
.msTag { font-style: normal; font-size: 7.6px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--amber); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 999px; padding: 1px 5px; }
.msText span { color: var(--dim); font-size: 9px; }
.msCount { font-family: var(--mono); font-size: 9.5px; color: var(--muted); }
.detail { padding: 11px 13px 12px; display: flex; flex-direction: column; gap: 7px; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(148, 163, 184, 0.35) transparent; }
.detail > * { flex: 0 0 auto; }
.detailHead { display: flex; align-items: baseline; gap: 8px; }
.detailHead b { font-size: 12.5px; }
.detailHead .pct { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); }
.detailKicker { color: var(--dim); font-size: 9.5px; margin-top: -3px; }
.detailHint { color: var(--muted); font-size: 10.5px; line-height: 1.5; margin: 0; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; min-height: 0; }
.col h4 { margin: 0 0 3px; font-size: 8.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
.col ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
.col li { position: relative; padding-left: 9px; font-size: 9.6px; line-height: 1.34; color: #c9d5ea; }
.col li::before { content: ""; position: absolute; left: 0; top: 5px; width: 3px; height: 3px; border-radius: 50%; background: var(--green); }
.col.open li::before { background: var(--amber); }
.evidence { font-family: var(--mono); font-size: 8.8px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 6px; margin-top: 3px; word-break: break-word; }
.recent { display: grid; gap: 3px; }
.recentRow { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 9.8px; color: #c9d5ea; }
.recentRow code { font-family: var(--mono); font-size: 8.8px; color: var(--cyan); opacity: 0.8; }
.recentRow span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.decisions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.decisions span { border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; font-size: 8.8px; color: var(--muted); }
.gate { display: flex; align-items: baseline; gap: 8px; margin-top: auto; padding-top: 7px; border-top: 1px solid var(--line); font-size: 8.8px; color: var(--dim); }
.gate b { font-family: var(--mono); color: var(--muted); font-weight: 500; }
.gate em { font-style: normal; margin-left: auto; color: var(--muted); }
.next { padding: 10px 13px 11px; }
.nextList { display: grid; gap: 3px; }
.nextList span { display: flex; gap: 7px; font-size: 9.8px; color: #c9d5ea; }
.nextList span::before { content: "→"; color: var(--cyan); font-family: var(--mono); }
footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; color: var(--dim); font-size: 9px; }
.legend { display: flex; gap: 10px; align-items: center; }
.legend i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
.note { font-family: var(--mono); font-size: 8.5px; color: rgba(148, 163, 184, 0.55); }
@keyframes rise { from { transform: translateY(3px); } to { transform: translateY(0); } }
@keyframes grow { from { transform: scaleX(0); } }
@keyframes ring { from { stroke-dashoffset: ${circumference.toFixed(2)}; } to { stroke-dashoffset: ${offset.toFixed(2)}; } }
@media (max-height: 880px) {
  .decisions { display: none; }
}
@media (max-height: 820px) {
  .recentRow:nth-child(n + 7) { display: none; }
  .shell { padding: 12px 16px 8px; gap: 9px; }
  h1 { font-size: clamp(18px, 1.9vw, 24px); }
  .stat { padding: 5px 8px; min-width: 66px; }
  .stat b { font-size: 14px; }
  .layer { padding: 3px 8px 3px 3px; }
  .layerKicker { display: none; }
  .ringWrap { width: 112px; height: 112px; }
  .mission { grid-template-columns: 112px minmax(0, 1fr); padding: 10px 12px; }
  .ringText b { font-size: 22px; }
  .chip { font-size: 8.6px; }
  .detail { padding: 9px 11px; }
  .col li { font-size: 9.1px; }
  .recentRow { font-size: 9.2px; }
}
@media (max-width: 1120px) {
  body { overflow: auto; }
  .shell { height: auto; }
  main { grid-template-columns: 1fr; }
  .stack { grid-auto-rows: auto; grid-template-rows: none; }
  .layer { padding: 8px; }
  .layerKicker { display: block; }
  aside { grid-template-rows: none; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  body.ready .chip { animation: none; }
  body.ready .bar span, body.ready .trackBar span, body.ready .ringFill { animation: none; }
}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div>
      <div class="brand"><span class="mark">◈</span> ios-sim · option A · native track</div>
      <h1>${escapeHtml(data.goal)}</h1>
      <p class="lede">${escapeHtml(data.subline)}</p>
    </div>
    <div class="stats">
      ${data.stats
        .map(
          (stat) =>
            `<div class="stat"><b>${escapeHtml(stat.value)}</b><span>${escapeHtml(stat.label)}</span></div>`,
        )
        .join("\n      ")}
    </div>
  </header>

  <main>
    <section class="card stack" aria-label="Architecture layers">
      <div class="stackHead"><b>Architecture</b><span>goal at the top · substrate at the bottom</span></div>
      ${data.layers.map((layer, index) => layerRow(layer, index)).join("\n      ")}
    </section>

    <aside>
      <section class="card mission" aria-label="Overall progress">
        <div class="ringWrap">
          <svg viewBox="0 0 132 132" aria-hidden="true">
            <defs>
              <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#34d399" />
                <stop offset="55%" stop-color="#22d3ee" />
                <stop offset="100%" stop-color="#a78bfa" />
              </linearGradient>
            </defs>
            <circle class="ringTrack" cx="66" cy="66" r="${radius}" />
            <circle class="ringFill" cx="66" cy="66" r="${radius}" />
          </svg>
          <div class="ringText"><b>${g1}%</b><span>G1 track</span></div>
        </div>
        <div class="missionText">
          <b>Shim-linked apps run.</b>
          <p>Eight substrate layers under the goal. The remaining gap is the stock-SDK binary path.</p>
          <div class="track">
            <div class="trackRow"><span>G1 shim</span><div class="trackBar"><span style="--p:${g1 / 100};background:linear-gradient(90deg,#34d399,#22d3ee)"></span></div><b>${g1}%</b></div>
            <div class="trackRow"><span>G2 .ipa</span><div class="trackBar"><span style="--p:${data.g2 / 100};background:linear-gradient(90deg,#fbbf24,#fb7185)"></span></div><b>${data.g2}%</b></div>
            <div class="trackRow"><span>M1 symbols</span><div class="trackBar"><span style="--p:${data.m1Covered / data.m1Budget};background:linear-gradient(90deg,#a78bfa,#22d3ee)"></span></div><b>${data.m1Covered}/${data.m1Budget}</b></div>
          </div>
        </div>
      </section>

      <section class="card milestones" aria-label="Milestones">
        <div class="cardTitle"><span>Milestones</span><span>done / steps</span></div>
        ${data.milestones.map(milestoneRow).join("\n        ")}
      </section>

      <section class="card detail" id="detail" aria-live="polite">
        ${detailDefault}
      </section>

      <section class="card next" aria-label="Next up">
        <div class="cardTitle"><span>Next up</span><span>${escapeHtml(data.updated)}</span></div>
        <div class="nextList">${data.next.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </section>
    </aside>
  </main>

  <footer>
    <div class="legend">
      <span><i style="background:var(--green)"></i>shipped</span>
      <span><i style="background:var(--amber)"></i>partial</span>
      <span><i style="background:var(--slate)"></i>planned</span>
      <span class="note">verified ${data.tests} tests · ${data.gated} gated · generated from scripts/architecture-progress.ts</span>
    </div>
    <div class="note">tab / enter to pin · esc to release · no Apple binaries · deterministic frames</div>
  </footer>
</div>

<script id="arch-data" type="application/json">${payload}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById("arch-data").textContent);
  const layers = new Map(data.layers.map((layer) => [layer.id, layer]));
  const detail = document.getElementById("detail");
  const rows = Array.from(document.querySelectorAll(".layer"));
  const fallback = detail.innerHTML;
  let pinned = null;

  const esc = (value) =>
    String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  function show(id) {
    const layer = layers.get(id);
    if (!layer) return;
    const list = (items, cls) =>
      '<ul class="' + cls + '">' +
      items.map((item) => '<li>' + esc(item) + '</li>').join("") +
      '</ul>';
    detail.innerHTML =
      '<div class="detailHead"><b>' + esc(layer.name) + '</b><span class="pct">' + layer.percent + '%</span></div>' +
      '<div class="detailKicker">' + esc(layer.kicker) + '</div>' +
      '<div class="cols">' +
        '<div class="col"><h4>Shipped</h4>' + list(layer.shipped, "done") + '</div>' +
        '<div class="col open"><h4>Open</h4>' + list(layer.open, "open") + '</div>' +
      '</div>' +
      '<div class="evidence">' + esc(layer.evidence) + '</div>';
    for (const row of rows) row.classList.toggle("active", row.dataset.layer === id);
  }

  function restore() {
    if (pinned) {
      show(pinned);
      return;
    }
    detail.innerHTML = fallback;
    for (const row of rows) row.classList.remove("active");
  }

  for (const row of rows) {
    row.addEventListener("mouseenter", () => show(row.dataset.layer));
    row.addEventListener("focus", () => show(row.dataset.layer));
    row.addEventListener("mouseleave", restore);
    row.addEventListener("blur", restore);
    row.addEventListener("click", () => {
      pinned = pinned === row.dataset.layer ? null : row.dataset.layer;
      if (pinned) show(pinned);
      else restore();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        row.click();
      }
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      pinned = null;
      restore();
    }
  });
  requestAnimationFrame(() => document.body.classList.add("ready"));
})();
</script>
</body>
</html>
`;
}
