/**
 * Property-based tests for the expression access-path parser/walker
 * (`src/compiler/expr.ts`). Target #2 — see docs/property-based-testing.md.
 *
 * The showcase property is a parser round-trip with a planted oracle: build a
 * random path, serialize it to access-path syntax, parse it back, and walk it to
 * recover a value planted at exactly that location. The serializer below is the
 * inverse of `parseAccessPath` over the grammar's representable subset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { parseAccessPath, walkPath, type Segment } from "../src/compiler/expr.ts";
import { WorkflowCompileError } from "../src/compiler/compile.ts";

// ── grammar-faithful generators & serializer ────────────────────────────────

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ID_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("");
const ID_CHAR = [...ID_START, ..."0123456789-".split("")];

// A bare identifier: /^[A-Za-z_][A-Za-z0-9_-]*$/ — the only form a root (or a
// dotted `.key`) segment may take.
const identifier = fc
  .tuple(fc.constantFrom(...ID_START), fc.array(fc.constantFrom(...ID_CHAR), { maxLength: 6 }))
  .map(([head, tail]) => head + tail.join(""));

// Any key representable via the bracket form `["..."]`. We always quote with `"`,
// so the only excluded keys are those containing `"`. `__proto__` is excluded to
// avoid JS's own-vs-prototype `[]` getter semantics muddying the oracle — a
// distinct concern, not this property's.
const bracketKey = fc.string({ unit: "binary", maxLength: 8 }).filter((k) => !k.includes('"') && k !== "__proto__");

// A non-root segment: a key (bare or bracketed) or a small array index.
const segment: fc.Arbitrary<Segment> = fc.oneof(
  fc.oneof(identifier, bracketKey).map((name) => ({ kind: "key", name }) as Segment),
  fc.nat({ max: 5 }).map((index) => ({ kind: "index", index }) as Segment),
);

// A full path: a root key (always a bare identifier) followed by 0..6 segments.
const pathArb: fc.Arbitrary<Segment[]> = fc
  .tuple(identifier, fc.array(segment, { maxLength: 6 }))
  .map(([root, rest]) => [{ kind: "key", name: root } as Segment, ...rest]);

/** Inverse of parseAccessPath over the representable subset. */
function serialize(segments: Segment[]): string {
  let out = "";
  segments.forEach((seg, i) => {
    if (seg.kind === "index") out += `[${seg.index}]`;
    else if (i === 0) out += seg.name; // root: bare identifier only
    else if (ID_RE.test(seg.name)) out += `.${seg.name}`;
    else out += `["${seg.name}"]`;
  });
  return out;
}

/** Build a nested object/array that holds `leaf` at exactly `segments`. */
function buildRoot(segments: Segment[], leaf: unknown): unknown {
  let acc = leaf;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.kind === "index") {
      const arr: unknown[] = new Array(seg.index + 1).fill(null);
      arr[seg.index] = acc;
      acc = arr;
    } else {
      acc = { [seg.name]: acc };
    }
  }
  return acc;
}

// ── P1: round-trip + recovery (the showcase) ────────────────────────────────
test("expr-path · parse∘serialize is identity and walk recovers the planted value", () => {
  fc.assert(
    fc.property(pathArb, fc.jsonValue(), (segments, leaf) => {
      const parsed = parseAccessPath(serialize(segments));
      assert.deepEqual(parsed, segments); // the parser is the exact inverse
      assert.deepEqual(walkPath(buildRoot(segments, leaf), parsed), leaf); // oracle
    }),
  );
});

// ── P2: walkPath totality ───────────────────────────────────────────────────
// Missing keys / out-of-range indices / scalar intermediates yield undefined,
// never a throw — for *any* root and *any* segment list.
test("expr-path · walkPath never throws on arbitrary roots and segments", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.array(segment, { maxLength: 6 }), (root, segs) => {
      walkPath(root, segs);
    }),
  );
});

// ── P3: parseAccessPath rejects malformed input ─────────────────────────────
// A valid path with a malformed tail appended must throw, not silently mis-parse.
const malformedTail = fc.constantFrom("[", "[1", "['a", "[@]", "[1.5]", "[]", "[ ]", ".5", ".");
test("expr-path · parseAccessPath rejects malformed paths", () => {
  fc.assert(
    fc.property(pathArb, malformedTail, (segments, bad) => {
      assert.throws(() => parseAccessPath(serialize(segments) + bad), WorkflowCompileError);
    }),
  );
});

// ── P4: missing semantics ───────────────────────────────────────────────────
// Walking one segment past a scalar leaf is "missing" → undefined, not a throw.
test("expr-path · walking past a scalar leaf yields undefined", () => {
  fc.assert(
    fc.property(
      pathArb,
      fc.oneof(fc.integer(), fc.boolean(), fc.string()),
      fc.oneof(identifier, bracketKey),
      (segments, leaf, extraKey) => {
        const root = buildRoot(segments, leaf);
        const extended: Segment[] = [...segments, { kind: "key", name: extraKey }];
        assert.equal(walkPath(root, extended), undefined);
      },
    ),
  );
});
