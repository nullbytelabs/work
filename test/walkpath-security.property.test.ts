/**
 * Security property tests: context access must return only OWN payload data, never
 * an inherited builtin. Target S-1 — see the Security track in
 * docs/property-based-testing.md.
 *
 * `walkPath` (src/compiler/expr.ts) is the shared sink for `${{ event.* }}`
 * interpolation and all `if:`/`when:` context roots. Event payloads are attacker-
 * controlled (webhooks), so a key like `constructor`/`__proto__`/`toString` must read
 * as "missing" rather than reaching a prototype gadget. The discriminating leak is
 * interpolation, where a non-scalar gets JSON.stringified into a run:/env: string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { walkPath, interpolate, type Segment } from "../src/compiler/expr.ts";

// Builtin / prototype keys an attacker might probe.
const BUILTIN_KEYS = [
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
];

const jsonKey = fc.string({ maxLength: 6 });
const eventPayload = fc.dictionary(jsonKey, fc.jsonValue(), { maxKeys: 5 });

// A path segment: a payload key, a builtin key, or an array index.
const segment: fc.Arbitrary<Segment> = fc.oneof(
  jsonKey.map((name) => ({ kind: "key", name }) as Segment),
  fc.constantFrom(...BUILTIN_KEYS).map((name) => ({ kind: "key", name }) as Segment),
  fc.nat({ max: 4 }).map((index) => ({ kind: "index", index }) as Segment),
);
const path = fc.array(segment, { minLength: 1, maxLength: 5 });

// Reference: the documented "own data only" semantics, written from the spec.
function ownWalk(root: unknown, segs: Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (seg.kind === "index") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    } else {
      if (!Object.hasOwn(cur, seg.name)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.name];
    }
  }
  return cur;
}

// ── P1: walkPath resolves own data only (own-walk oracle) ───────────────────
test("walkpath-security · walkPath agrees with an own-property-only walk", () => {
  fc.assert(
    fc.property(fc.jsonValue(), path, (root, segs) => {
      assert.deepEqual(walkPath(root, segs), ownWalk(root, segs));
    }),
  );
});

// ── P2: walking a JSON value never yields a function ─────────────────────────
// JSON payloads contain no functions, so a function result means a prototype
// builtin (Object.prototype.toString, etc.) leaked through.
test("walkpath-security · walkPath over a JSON value never returns a function", () => {
  fc.assert(
    fc.property(fc.jsonValue(), path, (root, segs) => {
      assert.notEqual(typeof walkPath(root, segs), "function");
    }),
  );
});

// ── P3: interpolation of a non-owned builtin key yields "" ──────────────────
// The leak surface: `${{ event.<builtin> }}` must interpolate to empty, never a
// stringified prototype object/function, into a run:/env: string.
test("walkpath-security · ${{ event.<builtin> }} interpolates to empty when not an own key", () => {
  fc.assert(
    fc.property(eventPayload, fc.constantFrom(...BUILTIN_KEYS), (payload, key) => {
      fc.pre(!Object.hasOwn(payload, key));
      assert.equal(interpolate(`\${{ event.${key} }}`, { event: payload }), "");
    }),
  );
});
