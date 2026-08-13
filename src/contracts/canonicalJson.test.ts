import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonStringify, parseCanonicalJson, parseCanonicalJsonBytes } from "./canonicalJson.js";

describe("parseCanonicalJson", () => {
  it("rejects duplicate decoded object keys", () => {
    expect(() => parseCanonicalJson(`{"a":1,"a":2}`)).toThrow(/duplicate key/);
  });

  it("rejects escaped duplicate decoded keys", () => {
    expect(() => parseCanonicalJson(`{"a":1,"\\u0061":2}`)).toThrow(/duplicate key/);
  });

  it("rejects lone surrogate escapes", () => {
    expect(() => parseCanonicalJson(`{"value":"\\uD800"}`)).toThrow(/invalid high surrogate/i);
  });

  it("rejects lone surrogates in object keys", () => {
    expect(() => parseCanonicalJson(`{"\\uD800":1}`)).toThrow(/lone high surrogate|invalid high surrogate/i);
  });

  it("does not treat BOM as trim whitespace", () => {
    expect(() => parseCanonicalJson("\uFEFF{\"a\":1}")).toThrow(/invalid token/i);
  });

  it("accepts only JSON whitespace as trim boundaries", () => {
    expect(() => parseCanonicalJson("\u000B{\"a\":1}\u000B")).toThrow(/invalid token/i);
  });

  it("accepts tab and CR/LF as boundaries", () => {
    expect(parseCanonicalJson("\t{\n\"a\":1\r\n}")).toEqual({ a: 1 });
  });

  it("treats duplicate escaped keys as duplicates even with proto-like names", () => {
    expect(() => parseCanonicalJson(`{"__proto__":1,"\\u005f\\u005fproto__":2}`)).toThrow(/duplicate key/);
  });

  it("accepts finite decimal fractions", () => {
    expect(parseCanonicalJson(`{"n":1.5}`)).toEqual({ n: 1.5 });
  });

  it("keeps __proto__ as an own data property", () => {
    const parsed = parseCanonicalJson(`{"__proto__":1,"safe":2}`) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  });

  it("rejects malformed UTF-8 byte input", () => {
    expect(() => parseCanonicalJsonBytes(new Uint8Array([0x80, 0xFF]))).toThrow(/invalid utf-8|UTF-8/i);
  });

  it("rejects leading UTF-8 BOM byte sequence", () => {
    expect(() => parseCanonicalJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(/leading BOM|BOM/i);
  });

  it("accepts ordinary UTF-8 byte input", () => {
    expect(parseCanonicalJsonBytes(new TextEncoder().encode("{\"a\":1}"))).toEqual({ a: 1 });
  });
});

describe("canonicalJsonStringify", () => {
  it("sorts UTF-16 object keys deterministically", () => {
    expect(canonicalJsonStringify({ b: 1, a: 1, "Ω": 1 })).toBe('{"a":1,"b":1,"Ω":1}');
    expect(canonicalJsonStringify({ "10": 1, "2": 2, a: 3 })).toBe('{"10":1,"2":2,"a":3}');
  });

  it("orders nested mixed UTF-16 keys with direct primitive serialization", () => {
    expect(canonicalJsonStringify({ z: 1, "2": 2, "10": 10, a: { "2": "two", "10": "ten", "a": "letter", "😀": "smile" } })).toBe(
      '{"10":10,"2":2,"a":{"10":"ten","2":"two","a":"letter","😀":"smile"},"z":1}'
    );
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify([{ z: 1 }, { a: 1 }])).toBe('[{"z":1},{"a":1}]');
  });

  it("rejects negative zero", () => {
    expect(() => canonicalJsonStringify({ value: -0 })).toThrow(/negative zero/);
  });

  it("rejects unsafe integers", () => {
    expect(() => canonicalJsonStringify({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe integer/);
  });

  it("matches ECMAScript JSON.stringify number spellings", () => {
    const safeCases = [
      { value: 0, expected: "0" },
      { value: 0.000001, expected: "0.000001" },
      { value: -0.000001, expected: "-0.000001" },
      { value: 1e-7, expected: "1e-7" },
      { value: -1e-7, expected: "-1e-7" },
      { value: 0.00000095, expected: "9.5e-7" },
      { value: -0.00000095, expected: "-9.5e-7" },
      { value: 0.0000015, expected: "0.0000015" },
      { value: -0.0000015, expected: "-0.0000015" },
      { value: 0.125, expected: "0.125" },
      { value: -0.125, expected: "-0.125" },
      { value: 2.2250738585072014e-308, expected: "2.2250738585072014e-308" },
      { value: -2.2250738585072014e-308, expected: "-2.2250738585072014e-308" },
      { value: 1.25, expected: "1.25" },
      { value: -1.25, expected: "-1.25" },
      { value: 999999.999999, expected: "999999.999999" },
      { value: -999999.999999, expected: "-999999.999999" },
      { value: 1e-10, expected: "1e-10" },
      { value: 5e-324, expected: "5e-324" }
    ];

    for (const entry of safeCases) {
      expect(JSON.stringify(entry.value)).toBe(entry.expected);
      expect(canonicalJsonStringify({ value: entry.value })).toBe(`{"value":${entry.expected}}`);
    }

    const unsafeSafeBoundaryCases = [
      { value: 1e20, expected: "100000000000000000000" },
      { value: -1e20, expected: "-100000000000000000000" },
      { value: 1e21, expected: "1e+21" },
      { value: -1e21, expected: "-1e+21" },
      { value: 1.7976931348623157e+308, expected: "1.7976931348623157e+308" }
    ];

    for (const entry of unsafeSafeBoundaryCases) {
      expect(JSON.stringify(entry.value)).toBe(entry.expected);
      expect(() => canonicalJsonStringify({ value: entry.value })).toThrow(/unsafe integer/);
    }
  });

  it("freezes formatter-only threshold hex and SHA evidence", () => {
    const evidence = [
      {
        expected: "100000000000000000000",
        canonicalHex: "7b2276223a3130303030303030303030303030303030303030307d",
        canonicalSha256: "8e85c1241e1aebc42bf95fcc16c0fef8b6d1de48d57f31096b9a7be664c2cebb"
      },
      {
        expected: "1e+21",
        canonicalHex: "7b2276223a31652b32317d",
        canonicalSha256: "9e24d139b060bd89f98e510a1e34d48fade6aeb668a016e6fb2e296762a3aefa"
      },
      {
        expected: "-100000000000000000000",
        canonicalHex: "7b2276223a2d3130303030303030303030303030303030303030307d",
        canonicalSha256: "afc9b072f80459d6f66c82bf9dfe00d5b152c945b67d6a02e9ac640965802fee"
      },
      {
        expected: "-1e+21",
        canonicalHex: "7b2276223a2d31652b32317d",
        canonicalSha256: "e2c8234e1548bc80ba238ba3913aeb55c4c324df829c9c0641b7966a8a9b1067"
      }
    ];

    for (const entry of evidence) {
      const canonicalText = `{"v":${entry.expected}}`;
      expect(Buffer.from(canonicalText).toString("hex")).toBe(entry.canonicalHex);
      expect(createHash("sha256").update(canonicalText).digest("hex")).toBe(entry.canonicalSha256);
    }
  });
});

describe("canonicalJsonBytes", () => {
  it("returns canonical UTF-8 bytes", () => {
    const bytes = canonicalJsonBytes({ b: 1, a: 1 });
    expect(bytes).toEqual(new TextEncoder().encode('{"a":1,"b":1}'));
  });
});

describe("canonical runtime validation", () => {
  it("rejects sparse arrays", () => {
    const sparse = [1];
    sparse[2] = 2;
    expect(() => canonicalJsonStringify(sparse)).toThrow(/sparse array/);
  });

  it("rejects accessor properties", () => {
    const target = {};
    Object.defineProperty(target, "value", {
      enumerable: true,
      get() {
        return 1;
      }
    });
    expect(() => canonicalJsonStringify({ target })).toThrow(/accessors?/);
  });

  it("rejects non-plain objects", () => {
    const value = new Date();
    expect(() => canonicalJsonStringify({ value })).toThrow(/non-plain object/);
  });

  it("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalJsonStringify(value)).toThrow(/cyclic/);
  });

  it("rejects BigInt and symbol members", () => {
    expect(() => canonicalJsonStringify({ value: 1n })).toThrow(/bigint/);
    expect(() => canonicalJsonStringify({ value: Symbol("x") as unknown as string })).toThrow(/symbol/);
  });

  it("accepts plain objects with plain nested arrays", () => {
    const value = { a: [{ b: 2 }, { c: 3 }] };
    expect(canonicalJsonStringify(value)).toBe('{"a":[{"b":2},{"c":3}]}');
  });

  it("rejects runtime lone high-surrogate string keys", () => {
    expect(() => canonicalJsonStringify({ "\ud800": 1 })).toThrow(/lone high surrogate/i);
  });

  it("rejects runtime lone low-surrogate string keys", () => {
    expect(() => canonicalJsonStringify({ "\udc00": 1 })).toThrow(/lone low surrogate/i);
  });

  it("accepts valid supplementary runtime string keys", () => {
    expect(canonicalJsonStringify({ "\uD834\uDF06": "clef" })).toBe(JSON.stringify({ "\uD834\uDF06": "clef" }));
  });
});
