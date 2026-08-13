import { TextDecoder, TextEncoder } from "node:util";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const utf8Bom = [0xef, 0xbb, 0xbf];
const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
const utf16Less = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const trimJsonWhitespace = (input: string) => {
  let start = 0;
  while (isWs(input[start] ?? "")) start += 1;
  let end = input.length;
  while (end > start && isWs(input[end - 1])) end -= 1;
  return input.slice(start, end);
};

const validateString = (value: string, path: string) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${path}: lone high surrogate`);
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${path}: lone low surrogate`);
    }
  }
};

const validateNumber = (value: number, path: string) => {
  if (!Number.isFinite(value)) throw new Error(`${path}: non-finite number`);
  if (Object.is(value, -0)) throw new Error(`${path}: negative zero`);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error(`${path}: unsafe integer`);
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isArrayIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key);

const canonicalize = (value: unknown, seen: Set<object>, path: string): unknown => {
  if (value === null) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    validateNumber(value, path);
    return value;
  }
  if (typeof value === "string") {
    validateString(value, path);
    return value;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`${path}: ${typeof value} is not canonical JSON`);
  }
  if (typeof value !== "object") throw new Error(`${path}: unsupported type`);
  if (seen.has(value)) throw new Error(`${path}: cyclic value`);
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path}: symbol-keyed value`);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "length") continue;
      if (!isArrayIndex(key) || Number(key) >= value.length) throw new Error(`${path}: non-index array property ${key}`);
    }
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error(`${path}: sparse array`);
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.get || desc.set || !desc.enumerable) throw new Error(`${path}: array accessor`);
      out[i] = canonicalize(desc.value, seen, `${path}[${i}]`);
    }
    seen.delete(value);
    return out;
  }

  if (!isPlainObject(value)) throw new Error(`${path}: non-plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path}: symbol-keyed property`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, unknown][] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    validateString(key, `${path} key ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}: accessor/non-enumerable property`);
    }
    entries.push([key, canonicalize(descriptor.value, seen, `${path}.${key}`)]);
  }
  seen.delete(value);
  const sortedEntries = entries.sort((left, right) => utf16Less(left[0], right[0]));
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, sortedValue] of sortedEntries) {
    out[key] = sortedValue;
  }
  return out;
};

const writeCanonicalValue = (value: unknown, out: string[]) => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      writeCanonicalValue(value[i], out);
    }
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    const asRecord = value as Record<string, unknown>;
    const keys = Object.keys(asRecord).sort(utf16Less);
    out.push("{");
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out.push(",");
      const key = keys[i]!;
      out.push(JSON.stringify(key));
      out.push(":");
      writeCanonicalValue(asRecord[key], out);
    }
    out.push("}");
    return;
  }
  throw new Error("unsupported canonical value");
};

export const canonicalJsonBytes = (value: unknown): Uint8Array => encoder.encode(canonicalJsonStringify(value));
export const canonicalJsonStringify = (value: unknown): string => {
  const out: string[] = [];
  writeCanonicalValue(canonicalize(value, new Set(), "root"), out);
  return out.join("");
};

const hasBOM = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === utf8Bom[0] && bytes[1] === utf8Bom[1] && bytes[2] === utf8Bom[2];

class Parser {
  private i = 0;
  public constructor(private readonly text: string) {}
  private skipWs() {
    while (isWs(this.text[this.i] ?? "")) this.i += 1;
  }
  private parseHex4() {
    let value = 0;
    for (let n = 0; n < 4; n += 1) {
      const ch = this.text[this.i];
      if (ch === undefined || !isHex(ch)) throw new Error(`invalid hex escape at position ${this.i}`);
      value = value * 16 + Number.parseInt(ch, 16);
      this.i += 1;
    }
    return value;
  }
  private parseUnicodeEscape() {
    const high = this.parseHex4();
    if (high < 0xd800 || high > 0xdbff) return String.fromCharCode(high);
    if (this.text[this.i] !== "\\" || this.text[this.i + 1] !== "u") throw new Error(`invalid high surrogate at position ${this.i}`);
    this.i += 2;
    const low = this.parseHex4();
    if (low < 0xdc00 || low > 0xdfff) throw new Error(`invalid low surrogate at position ${this.i}`);
    return String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
  }
  private parseString(path: string) {
    if (this.text[this.i] !== '"') throw new Error(`invalid string start at position ${this.i}`);
    this.i += 1;
    let out = "";
    while (this.i < this.text.length) {
      const ch = this.text[this.i];
      if (ch === undefined) throw new Error(`unterminated string at position ${this.i}`);
      if (ch === '"') {
        this.i += 1;
        validateString(out, path);
        return out;
      }
      if (ch === "\\") {
        const escaped = this.text[this.i + 1];
        if (escaped === undefined) throw new Error(`unterminated escape at position ${this.i}`);
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (Object.prototype.hasOwnProperty.call(map, escaped)) {
          out += map[escaped]!;
          this.i += 2;
          continue;
        }
        if (escaped === "u") {
          this.i += 2;
          out += this.parseUnicodeEscape();
          continue;
        }
        throw new Error(`invalid escape \\${escaped} at position ${this.i}`);
      }
      const code = ch.charCodeAt(0);
      if (code <= 0x1f) throw new Error(`control character must be escaped at position ${this.i}`);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.text.charCodeAt(this.i + 1);
        if (low < 0xdc00 || low > 0xdfff) throw new Error(`invalid high surrogate at position ${this.i}`);
        out += ch + (this.text[this.i + 1] ?? "");
        this.i += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`invalid low surrogate at position ${this.i}`);
      out += ch;
      this.i += 1;
    }
    throw new Error(`unterminated string at position ${this.i}`);
  }
  private parseNumber(path: string) {
    const start = this.i;
    if (this.text[this.i] === "-") this.i += 1;
    if (this.text[this.i] === "0") {
      this.i += 1;
      if (isDigit(this.text[this.i] ?? "")) throw new Error(`invalid number at position ${start}`);
    } else {
      if (!isDigit(this.text[this.i] ?? "")) throw new Error(`invalid number at position ${start}`);
      while (isDigit(this.text[this.i] ?? "")) this.i += 1;
    }
    if (this.text[this.i] === ".") {
      this.i += 1;
      if (!isDigit(this.text[this.i] ?? "")) throw new Error(`invalid number fraction at position ${start}`);
      while (isDigit(this.text[this.i] ?? "")) this.i += 1;
    }
    if (this.text[this.i] === "e" || this.text[this.i] === "E") {
      this.i += 1;
      if (this.text[this.i] === "+" || this.text[this.i] === "-") this.i += 1;
      if (!isDigit(this.text[this.i] ?? "")) throw new Error(`invalid number exponent at position ${start}`);
      while (isDigit(this.text[this.i] ?? "")) this.i += 1;
    }
    const raw = this.text.slice(start, this.i);
    const value = Number(raw);
    validateNumber(value, `${path} ${raw}`);
    return value;
  }
  private parseLiteral(token: string) {
    if (!this.text.startsWith(token, this.i)) return undefined;
    this.i += token.length;
    return token === "true" ? true : token === "false" ? false : null;
  }
  private parseArray(path: string) {
    this.i += 1;
    const out: unknown[] = [];
    while (this.i < this.text.length) {
      this.skipWs();
      if (this.text[this.i] === "]") {
        this.i += 1;
        return out;
      }
      out.push(this.parseValue(`${path}[${out.length}]`));
      this.skipWs();
      if (this.text[this.i] === ",") {
        this.i += 1;
        this.skipWs();
        if (this.text[this.i] === "]") throw new Error(`invalid trailing comma at position ${this.i}`);
        continue;
      }
      if (this.text[this.i] === "]") {
        this.i += 1;
        return out;
      }
      throw new Error(`invalid array terminator at position ${this.i}`);
    }
    throw new Error("unterminated array");
  }
  private parseObject(path: string) {
    this.i += 1;
    const out: Record<string, unknown> = Object.create(null);
    const seenKeys = new Set<string>();
    while (this.i < this.text.length) {
      this.skipWs();
      if (this.text[this.i] === "}") {
        this.i += 1;
        return out;
      }
      if (this.text[this.i] !== '"') throw new Error(`invalid object key at position ${this.i}`);
      const key = this.parseString(`${path} key`);
      if (seenKeys.has(key)) throw new Error(`duplicate key "${key}"`);
      seenKeys.add(key);
      this.skipWs();
      if (this.text[this.i] !== ":") throw new Error(`invalid object key/value delimiter at position ${this.i}`);
      this.i += 1;
      this.skipWs();
      out[key] = this.parseValue(`${path}.${key}`);
      this.skipWs();
      if (this.text[this.i] === ",") {
        this.i += 1;
        this.skipWs();
        if (this.text[this.i] === "}") throw new Error(`invalid trailing comma at position ${this.i}`);
        continue;
      }
      if (this.text[this.i] === "}") {
        this.i += 1;
        return out;
      }
      throw new Error(`invalid object terminator at position ${this.i}`);
    }
    throw new Error("unterminated object");
  }
  private parseValue(path: string) {
    this.skipWs();
    const ch = this.text[this.i];
    if (ch === undefined) throw new Error("unexpected end of JSON");
    if (ch === "{") return this.parseObject(path);
    if (ch === "[") return this.parseArray(path);
    if (ch === '"') return this.parseString(`${path} value`);
    if (ch === "-" || isDigit(ch)) return this.parseNumber(`${path} value`);
    const literal = this.parseLiteral("true");
    if (literal !== undefined) return literal;
    const literalFalse = this.parseLiteral("false");
    if (literalFalse !== undefined) return literalFalse;
    const literalNull = this.parseLiteral("null");
    if (literalNull !== undefined) return literalNull;
    throw new Error(`invalid token at position ${this.i}`);
  }
  public parse(): unknown {
    const value = this.parseValue("root");
    this.skipWs();
    if (this.i !== this.text.length) throw new Error(`unexpected trailing content at position ${this.i}`);
    return value;
  }
}

export const parseCanonicalJson = (input: string): unknown => {
  const text = trimJsonWhitespace(input);
  if (text.length === 0) throw new Error("empty JSON");
  return canonicalize(new Parser(text).parse(), new Set(), "root");
};

export const parseCanonicalJsonBytes = (bytes: Uint8Array): unknown => {
  if (hasBOM(bytes)) {
    throw new Error("invalid UTF-8: leading BOM is not allowed");
  }
  return parseCanonicalJson(decoder.decode(bytes));
};
