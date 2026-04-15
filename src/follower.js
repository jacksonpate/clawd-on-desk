// src/follower.js — Cursor-following and boredom-wander behavior
// Clawd walks toward wherever the user is actively working,
// freezes during coding/error/sleep states, and falls dramatically on error.

const { screen } = require("electron");

// ── Tuning ──
const TICK_MS            = 16;
const CURSOR_POLL_MS     = 50;
const DWELL_THRESHOLD_MS = 3000;   // cursor dwell before Clawd walks over
const DWELL_RADIUS       = 150;
const BOREDOM_MS         = 5 * 60 * 1000;
const WANDER_STAY_MIN    = 30 * 1000;
const WANDER_STAY_MAX    = 60 * 1000;
const ARRIVE_THRESHOLD   = 3;

// Walk speed — steady pace, ~80px/sec. Small guy, takes his time.
const WALK_SPEED         = 80  / 1000 * TICK_MS;
// Fall speed — dramatic. ~600px/sec.
const FALL_SPEED         = 600 / 1000 * TICK_MS;

// Personal space — only follow if this far away
const FOLLOW_MIN_DIST    = 400;
// Random polar offset range when picking a spot near cursor
const FOLLOW_DIST_MIN    = 180;
const FOLLOW_DIST_MAX    = 320;

const RETARGET_MIN_DIST  = 100;

// Bob
const WALK_START_DIST    = 20;
const BOB_FREQ           = 0.013;
const BOB_AMP            = 2.5;

// States where Clawd freezes in place (don't walk while these are active)
const LOCKED_STATES = new Set([
  "working", "typing", "building", "juggling", "conducting", "thinking",
  "sleeping", "yawning", "dozing", "collapsing",
]);

module.exports = function initFollower(ctx) {

let tickTimer        = null;
let targetX          = null;
let targetY          = null;
let floatX           = null;
let floatY           = null;

// Cursor dwell
let lastCursorX      = null;
let lastCursorY      = null;
let dwellAnchorX     = null;
let dwellAnchorY     = null;
let dwellSince       = null;

// Monitor boredom
let curMonitorId     = null;
let monitorSince     = Date.now();

// Wander
let wandering        = false;
let wanderStayTimer  = null;

// Walk
let isWalking        = false;

// Error fall
let isFalling        = false;
let prevState        = null;

// ── Helpers ──
function dist(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function clampTo(wa, tx, ty, w, h) {
  const m = 10;
  return {
    x: Math.max(wa.x + m, Math.min(wa.x + wa.width  - w - m, tx)),
    y: Math.max(wa.y + m, Math.min(wa.y + wa.height - h - m, ty)),
  };
}

// Pick a spot near cursor at a random angle and distance — any side
function targetNearCursor(cx, cy, w, h) {
  const display  = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const angle    = Math.random() * 2 * Math.PI;
  const distance = FOLLOW_DIST_MIN + Math.random() * (FOLLOW_DIST_MAX - FOLLOW_DIST_MIN);
  const tx       = cx + Math.cos(angle) * distance;
  const ty       = cy + Math.sin(angle) * distance;
  return clampTo(display.workArea, tx, ty, w, h);
}

function randomWanderTarget(w, h) {
  const displays = screen.getAllDisplays();
  let pool = displays.filter(d => d.id !== curMonitorId);
  if (pool.length === 0) pool = displays;
  const d  = pool[Math.floor(Math.random() * pool.length)];
  const wa = d.workArea;
  const m  = 80;
  const rx = wa.x + m + Math.floor(Math.random() * Math.max(1, wa.width  - w - m * 2));
  const ry = wa.y + m + Math.floor(Math.random() * Math.max(1, wa.height - h - m * 2));
  return clampTo(wa, rx, ry, w, h);
}

// Fall target — bottom of whatever display he's currently on
function fallTarget(bounds, w, h) {
  const cx      = bounds.x + w / 2;
  const cy      = bounds.y + h / 2;
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const wa      = display.workArea;
  return clampTo(wa, bounds.x, wa.y + wa.height - h - 10, w, h);
}

// ── Cursor / target polling (50ms) ──
let lastPollAt = 0;
function pollCursorAndTarget() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const bounds  = ctx.win.getBounds();
  const cursor  = screen.getCursorScreenPoint();
  const cx = cursor.x, cy = cursor.y;

  // ── Error fall detection (disabled) ──
  const curState = ctx.currentState;
  prevState = curState;

  // Skip target updates while falling, manually frozen, or locked
  if (isFalling) return;
  if (manualFreeze) return;
  if (LOCKED_STATES.has(curState)) {
    // Clear pending target so he doesn't lurch when unlocked
    if (!wandering) { targetX = null; targetY = null; }
    return;
  }

  // Monitor tracking (boredom timer)
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  if (display.id !== curMonitorId) {
    curMonitorId = display.id;
    monitorSince = Date.now();
  }

  // Cursor dwell
  if (lastCursorX === null) {
    lastCursorX = cx; lastCursorY = cy;
    dwellAnchorX = cx; dwellAnchorY = cy;
    dwellSince = Date.now();
  }
  const moved = Math.abs(cx - lastCursorX) > 3 || Math.abs(cy - lastCursorY) > 3;
  lastCursorX = cx; lastCursorY = cy;
  if (moved && dist(cx, cy, dwellAnchorX, dwellAnchorY) > DWELL_RADIUS) {
    dwellAnchorX = cx; dwellAnchorY = cy;
    dwellSince = Date.now();
  }
  const dwelled = (Date.now() - dwellSince) >= DWELL_THRESHOLD_MS;

  // Boredom wander — free walk on any unlocked state
  if (!wandering && targetX === null && (Date.now() - monitorSince) >= BOREDOM_MS) {
    wandering = true;
    monitorSince = Date.now();
    const wt = randomWanderTarget(bounds.width, bounds.height);
    targetX = wt.x;
    targetY = wt.y;
  }

  // Follow cursor — only if dwelled AND Clawd is far away (personal space)
  if (!wandering && dwelled) {
    const clawd_cx = bounds.x + bounds.width  / 2;
    const clawd_cy = bounds.y + bounds.height / 2;
    const toCursor = dist(clawd_cx, clawd_cy, cx, cy);
    if (toCursor > FOLLOW_MIN_DIST) {
      const t = targetNearCursor(cx, cy, bounds.width, bounds.height);
      if (targetX === null || dist(t.x, t.y, targetX, targetY) > RETARGET_MIN_DIST) {
        targetX = t.x;
        targetY = t.y;
      }
    }
  }
}

// ── Movement tick — ~60fps ──
function tick() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (ctx.dragLocked || ctx.miniMode || ctx.miniTransitioning) return;

  const now = Date.now();
  if (now - lastPollAt >= CURSOR_POLL_MS) {
    lastPollAt = now;
    pollCursorAndTarget();
  }

  // Locked states freeze movement (fall bypasses this)
  if (!isFalling && (manualFreeze || LOCKED_STATES.has(ctx.currentState))) {
    if (isWalking) isWalking = false;
    return;
  }

  if (targetX === null || targetY === null) {
    if (isWalking) isWalking = false;
    return;
  }

  if (floatX === null) {
    const b = ctx.win.getBounds();
    floatX = b.x; floatY = b.y;
  }

  const d = dist(floatX, floatY, targetX, targetY);
  if (!isWalking && d > WALK_START_DIST) isWalking = true;

  if (d <= ARRIVE_THRESHOLD) {
    isWalking = false;
    isFalling = false;
    floatX = targetX;
    floatY = targetY;
    if (wandering && wanderStayTimer === null) {
      const stay = WANDER_STAY_MIN + Math.random() * (WANDER_STAY_MAX - WANDER_STAY_MIN);
      wanderStayTimer = setTimeout(() => {
        wanderStayTimer = null;
        wandering = false;
        targetX = null;
        targetY = null;
      }, stay);
    } else if (!wandering) {
      targetX = null;
      targetY = null;
    }
    return;
  }

  const speed = isFalling ? FALL_SPEED : WALK_SPEED;
  const step  = Math.min(speed, d);
  floatX += (targetX - floatX) / d * step;
  floatY += (targetY - floatY) / d * step;

  // Footstep bob only while walking (not falling)
  const bob = (isWalking && !isFalling) ? Math.sin(now * BOB_FREQ) * BOB_AMP : 0;

  ctx.moveWindowTo(Math.round(floatX), Math.round(floatY + bob));
}

function start() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, TICK_MS);
}

function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (wanderStayTimer) { clearTimeout(wanderStayTimer); wanderStayTimer = null; }
  targetX = null; targetY = null;
  floatX = null; floatY = null;
  wandering = false; isWalking = false; isFalling = false;
  lastCursorX = null; lastCursorY = null;
  dwellAnchorX = null; dwellAnchorY = null;
  dwellSince = null; prevState = null;
}

// Sync float position from actual window bounds (call after external moves like drag)
function syncPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const b = ctx.win.getBounds();
  floatX = b.x;
  floatY = b.y;
  targetX = null;
  targetY = null;
  wandering = false;
  if (wanderStayTimer) { clearTimeout(wanderStayTimer); wanderStayTimer = null; }
}

// Manual freeze — stop all movement until unfreeze() is called
let manualFreeze = false;
function freeze() {
  manualFreeze = true;
  targetX = null;
  targetY = null;
  wandering = false;
  isWalking = false;
  if (wanderStayTimer) { clearTimeout(wanderStayTimer); wanderStayTimer = null; }
}
function unfreeze() {
  manualFreeze = false;
  syncPosition();
}
function isFrozen() { return manualFreeze; }

return { start, stop, syncPosition, freeze, unfreeze, isFrozen };

};
